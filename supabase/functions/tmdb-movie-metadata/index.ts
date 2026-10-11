import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tmdbFetch(path: string, params: Record<string, string>) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (res.ok) return await res.json();
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get("retry-after")) || 1;
        await sleep((retryAfter + 0.5) * 1000);
        continue;
      }
      if (res.status >= 500) {
        await sleep(500 * (attempt + 1));
        continue;
      }
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

// include_adult:falseで固定(trueだとタイトルの一部一致だけでアダルト作品が
// 紛れ込み、無関係な映画に誤ったデータを紐付ける事故になるため)
// TMDbのsearch/movieのyearパラメータは厳密な絞り込みではなく優先ヒントに
// すぎないため、"Home"のような短い/ありふれたタイトルではyear指定時でも
// 無関係な人気作(例:「ホーム・アローン2」)がresults[0]に来ることがある。
// 以前はこれを無条件にyearCorroborated:trueとして信頼していたため、
// 「Home」(2009のフランス映画)のような行に無関係な別作品のtmdb_idが
// 書き込まれる事故が起きていた(オーナー指摘で発覚、ドラえもん関連作品の
// 英題重複の調査中に発見)。年指定の検索でも、実際のrelease_dateが
// 指定年と一致する候補だけを信頼する(無ければ下のフォールバックに進む)。
async function searchMovie(title: string, year: number | null): Promise<{ result: any; yearCorroborated: boolean } | null> {
  if (year) {
    for (const language of ["ja-JP", "en-US"]) {
      const data = await tmdbFetch("/search/movie", { query: title, include_adult: "false", language, year: String(year) });
      const corroborated = (data?.results || []).find((c: any) => {
        const cy = c.release_date ? parseInt(String(c.release_date).slice(0, 4), 10) : null;
        return cy != null && Math.abs(cy - year) <= 1;
      });
      if (corroborated) return { result: corroborated, yearCorroborated: true };
    }
  }

  const candidates: any[] = [];
  for (const language of ["ja-JP", "en-US"]) {
    const data = await tmdbFetch("/search/movie", { query: title, include_adult: "false", language });
    if (data?.results?.length) candidates.push(...data.results);
  }
  if (candidates.length === 0) return null;
  if (!year) return { result: candidates[0], yearCorroborated: false };

  for (const c of candidates) {
    const cy = c.release_date ? parseInt(String(c.release_date).slice(0, 4), 10) : null;
    if (cy != null && Math.abs(cy - year) <= 1) return { result: c, yearCorroborated: true };
  }
  return null;
}

// ja-JPのoverviewが空の作品だけを狙って直す専用モード。tmdb_idは既に
// 確定済みなので検索をやり直さず、/movie/{tmdb_id}をja-JP→(空なら)en-USで
// 取得してsynopsisだけ埋める。director/cast/countryは既に正しく入って
// いる行が対象なので触らない。
async function fillMissingSynopsis(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title, tmdb_id")
    .not("tmdb_id", "is", null)
    .or("synopsis.is.null,synopsis.eq.")
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const todo = data || [];

  const results = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (m: any) => {
        let details = await tmdbFetch(`/movie/${m.tmdb_id}`, { language: "ja-JP" });
        let overview = details?.overview || null;
        if (!overview) {
          const enDetails = await tmdbFetch(`/movie/${m.tmdb_id}`, { language: "en-US" });
          overview = enDetails?.overview || null;
        }
        if (overview && write) {
          await supabase.from("movies").update({ synopsis: overview }).eq("id", m.id);
        }
        return { movie_id: m.id, title: m.title, tmdb_id: m.tmdb_id, synopsis: overview, found: !!details };
      }),
    );
    results.push(...chunkResults);
    await sleep(150);
  }
  return results;
}

// 見放題(flatrate)の配信先と、その「視聴ページリンク」(watch/providersの
// results.JP.link)をJP向けに取得して保存する。TMDbの無料APIは各配信
// サービス(Netflix/Amazon等)への直接ディープリンクを提供しない(JustWatchの
// 有料/提携APIのみ)ため、実際にユーザーが配信先へ辿り着ける唯一の公式
// リンクはこのTMDb自身の視聴ページ(themoviedb.org/movie/{id}/watch)になる
// (オーナーに直接確認済み:「自動リンクがいい」。NetflixやAmazon自体へは
// 直接飛ばず、このTMDbページ経由のワンクッションになることは説明済み)。
// vod_checked_atを「確認済みの印」として使い、配信先が無い(空配列)作品も
// 再取得し続けないようにする。
async function fillVodFlatrate(supabase: any, offset: number, limit: number, write: boolean) {
  const { data, error } = await supabase
    .from("movies")
    .select("id, title, tmdb_id")
    .eq("media_type", "movie")
    .not("tmdb_id", "is", null)
    .is("vod_checked_at", null)
    .order("id", { ascending: true })
    .range(offset, offset + limit - 1);
  if (error) throw error;
  const todo = data || [];

  const results = [];
  const CONCURRENCY = 3;
  for (let i = 0; i < todo.length; i += CONCURRENCY) {
    const chunk = todo.slice(i, i + CONCURRENCY);
    const chunkResults = await Promise.all(
      chunk.map(async (m: any) => {
        const wp = await tmdbFetch(`/movie/${m.tmdb_id}/watch/providers`, {});
        const flatrate = (wp?.results?.JP?.flatrate || []).map((p: any) => p.provider_name);
        const watchLink = wp?.results?.JP?.link || null;
        if (write) {
          await supabase.from("movies").update({
            vod_flatrate: flatrate,
            vod_watch_link: watchLink,
            vod_checked_at: new Date().toISOString(),
          }).eq("id", m.id);
        }
        return { movie_id: m.id, title: m.title, tmdb_id: m.tmdb_id, flatrate, watchLink };
      }),
    );
    results.push(...chunkResults);
    await sleep(150);
  }
  return results;
}

Deno.serve(async (req: Request) => {
  try {
    const {
      offset = 0,
      limit = 20,
      ids = null,
      tmdb_id_overrides = null,
      debug_title = null,
      target = "no_director",
      write = false,
    } = await req.json().catch(() => ({}));

    if (debug_title) {
      const ja = await tmdbFetch("/search/movie", { query: debug_title, include_adult: "false", language: "ja-JP" });
      return new Response(JSON.stringify(ja), { headers: { "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    if (!ids && target === "missing_synopsis") {
      const results = await fillMissingSynopsis(supabase, offset, limit, write);
      return new Response(JSON.stringify({ offset, limit, processed: results.length, write, results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    if (!ids && target === "vod_flatrate") {
      const results = await fillVodFlatrate(supabase, offset, limit, write);
      return new Response(JSON.stringify({ offset, limit, processed: results.length, write, results }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    let todo: any[];
    if (ids) {
      const { data, error } = await supabase.from("movies").select("id, title, release_year").in("id", ids);
      if (error) throw error;
      todo = data || [];
    } else {
      const { data, error } = await supabase
        .from("movies")
        .select("id, title, release_year")
        .is("director", null)
        .order("id", { ascending: true })
        .range(offset, offset + limit - 1);
      if (error) throw error;
      todo = data || [];
    }

    const results = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (m: any) => {
          const forcedId = tmdb_id_overrides?.[String(m.id)];
          const searched = forcedId
            ? { result: { id: forcedId, title: null }, yearCorroborated: true }
            : await searchMovie(m.title, m.release_year);
          const match = searched?.result ?? null;
          if (!match) {
            return { movie_id: m.id, title: m.title, release_year: m.release_year, tmdb_matched: false };
          }

          const [details, credits] = await Promise.all([
            tmdbFetch(`/movie/${match.id}`, { language: "ja-JP" }),
            tmdbFetch(`/movie/${match.id}/credits`, { language: "ja-JP" }),
          ]);

          // TMDbのoverviewは言語ごとの翻訳データで、日本語訳が存在しない
          // 作品(特に邦画以外)ではja-JPのoverviewが空文字列になる。これを
          // 無条件にnullへ変換していたため、英語版にはあらすじがあるのに
          // 日本語版が未翻訳なだけの作品まで「あらすじ無し」として保存
          // される事故が起きていた(オーナー指摘で発覚、tmdb_id紐付け済み
          // なのにsynopsisがnullの行の99.5%で裏付けを確認)。ja-JPが空の
          // 場合のみen-USへフォールバックする。
          let overview = details?.overview || null;
          if (!overview) {
            const enDetails = await tmdbFetch(`/movie/${match.id}`, { language: "en-US" });
            overview = enDetails?.overview || null;
          }

          const directors = (credits?.crew || []).filter((c: any) => c.job === "Director").map((c: any) => c.name);
          const cast = (credits?.cast || []).slice(0, 5).map((c: any) => c.name);
          const countries = (details?.production_countries || []).map((c: any) => c.name);

          const row = {
            movie_id: m.id,
            title: m.title,
            release_year: m.release_year,
            tmdb_matched: true,
            tmdb_id: match.id,
            tmdb_title: details?.title ?? match.title,
            year_corroborated: searched?.yearCorroborated ?? true,
            director: directors.join("、") || null,
            cast: cast.length ? cast : null,
            country: countries.join("・") || null,
            synopsis: overview,
          };

          if (write) {
            await supabase.from("movies").update({
              tmdb_id: row.tmdb_id,
              director: row.director,
              cast_members: row.cast,
              country: row.country,
              synopsis: row.synopsis,
            }).eq("id", m.id);
          }

          return row;
        }),
      );
      results.push(...chunkResults);
      await sleep(150);
    }

    return new Response(JSON.stringify({ offset, limit, processed: todo.length, write, results }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
