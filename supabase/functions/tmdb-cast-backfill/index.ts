import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// オーナー報告(「主演情報など抜け落ちを確認した」)を受けて調査。
// tmdb-discover-movies/tmdb-discover-anime/tmdb-discover-drama は取り込み時に
// 一度だけ/movie(tv)/{id}/creditsを叩き、失敗・空だった場合はcast_members=null
// のまま確定し、以後やり直す仕組みが無かった(実データ確認: movie 787件・
// drama 128件・anime 74件、計989件がcast_members無しのまま)。本関数は
// tmdb_idを持つ既存行を見直し、もう一度creditsを取得してcast_membersを
// 埋める(他のbackfill系と同じ、offset/limitページング+checked_atガード方式)。
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
      // 404等。この作品のcreditsが無いという確定情報として扱う(nullを返す)。
      return null;
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 30, write = false } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    // 対象: 映画・アニメ・ドラマ(実写・アニメ向けの「主演」欄がある種別、
    // renderMovieInfoPanelのhasCastField判定と同じ条件)のうち、
    // cast_membersが空でtmdb_idがあり、まだこの関数で確認していない行。
    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, tmdb_id, media_type, title")
      .or("media_type.eq.movie,is_anime.eq.true,is_drama.eq.true")
      .not("tmdb_id", "is", null)
      .or("cast_members.is.null,cast_members.eq.{}")
      .is("cast_checked_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    const todo = rows || [];

    const results: any[] = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (m: any) => {
          const creditsPath = m.media_type === "tv" ? `/tv/${m.tmdb_id}/credits` : `/movie/${m.tmdb_id}/credits`;
          const credits = await tmdbFetch(creditsPath, { language: "ja-JP" });
          if (credits === null) {
            // 一時的な通信障害の可能性もあるため、checked_atは立てず次回に回す
            // (synopsis-backfill等の既存パイプラインと同じ安全策)。ただし
            // creditsオブジェクト自体が返ってきて単にcastが空の場合は
            // 「本当に無い」と確定させてchecked_atを立てる(下のelse節)。
            return { movie_id: m.id, title: m.title, found: false, transientError: true };
          }
          const cast = (credits?.cast || []).slice(0, 5).map((p: any) => p.name).filter(Boolean);
          if (write) {
            const update: Record<string, unknown> = { cast_checked_at: new Date().toISOString() };
            if (cast.length) update.cast_members = cast;
            await supabase.from("movies").update(update).eq("id", m.id);
          }
          return { movie_id: m.id, title: m.title, found: cast.length > 0, cast };
        }),
      );
      results.push(...chunkResults);
      await sleep(200);
    }

    return new Response(
      JSON.stringify({
        offset,
        limit,
        write,
        processed: results.length,
        found: results.filter((r) => r.found).length,
        results,
      }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
