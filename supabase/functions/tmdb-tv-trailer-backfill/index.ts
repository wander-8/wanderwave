import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// tmdb-trailer-backfillのTV版。既存のtmdb-trailer-backfillは/movie/配下しか
// 叩かないため、tmdb_idの名前空間が異なるTVシリーズ(media_type='tv')には
// そのまま使えない。対象をmedia_type='tv'に絞り、/tv/配下のエンドポイントで
// 予告編を埋める専用の穴埋め関数。

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

async function searchTmdbTvId(title: string, year: number | null): Promise<number | null> {
  if (year) {
    const data = await tmdbFetch("/search/tv", { query: title, language: "ja-JP", first_air_date_year: String(year) });
    if (data?.results?.length) return data.results[0].id;
  }
  const data = await tmdbFetch("/search/tv", { query: title, language: "ja-JP" });
  const candidates = data?.results || [];
  if (!candidates.length) return null;
  if (!year) return candidates[0].id;
  for (const c of candidates) {
    const cy = c.first_air_date ? parseInt(String(c.first_air_date).slice(0, 4), 10) : null;
    if (cy != null && Math.abs(cy - year) <= 1) return c.id;
  }
  return candidates[0].id;
}

// tmdb-trailer-backfillと同じ選び方: YouTubeの「Trailer」最優先、無ければ「Teaser」。
// 同じtypeの中では公式を優先し、それでも並んだら公開日が新しいものを選ぶ。
function pickBestVideo(videos: any[]): any | null {
  const youtube = videos.filter((v) => v.site === "YouTube" && v.key);
  for (const type of ["Trailer", "Teaser"]) {
    const ofType = youtube.filter((v) => v.type === type);
    if (!ofType.length) continue;
    ofType.sort((a, b) => {
      if (!!b.official !== !!a.official) return (b.official ? 1 : 0) - (a.official ? 1 : 0);
      return String(b.published_at || "").localeCompare(String(a.published_at || ""));
    });
    return ofType[0];
  }
  return null;
}

Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 50 } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: movies, error } = await supabase
      .from("movies")
      .select("id, title, release_year, tmdb_id")
      .eq("media_type", "tv")
      .is("trailer_checked_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    let updated = 0;
    let notFound = 0;
    const CONCURRENCY = 3;
    const todo = movies || [];
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (m: any) => {
          let tmdbId: number | null = m.tmdb_id ?? null;
          if (!tmdbId) {
            tmdbId = await searchTmdbTvId(m.title, m.release_year);
            if (tmdbId) await supabase.from("movies").update({ tmdb_id: tmdbId }).eq("id", m.id);
          }

          let trailerKey: string | null = null;
          if (tmdbId) {
            const data = await tmdbFetch(`/tv/${tmdbId}/videos`, { language: "ja-JP" });
            let best = pickBestVideo(data?.results || []);
            if (!best) {
              const dataEn = await tmdbFetch(`/tv/${tmdbId}/videos`, { language: "en-US" });
              best = pickBestVideo(dataEn?.results || []);
            }
            trailerKey = best?.key || null;
          }
          if (!tmdbId || !trailerKey) notFound++;

          const { error: updateErr } = await supabase
            .from("movies")
            .update({ trailer_key: trailerKey, trailer_checked_at: new Date().toISOString() })
            .eq("id", m.id);
          if (!updateErr) updated++;
        }),
      );
      await sleep(150);
    }

    return new Response(
      JSON.stringify({ offset, limit, processed: todo.length, updated, not_found: notFound }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
