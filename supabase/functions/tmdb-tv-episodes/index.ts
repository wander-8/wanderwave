import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function tmdbFetch(path: string, params: Record<string, string> = {}) {
  const url = new URL(`https://api.themoviedb.org/3${path}`);
  url.searchParams.set("api_key", TMDB_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url.toString());
  if (!res.ok) return null;
  return await res.json();
}

// tmdb-movie-reviewsと同じ考え方: tmdb_idをまだ知らない作品はタイトル+年で検索し、
// 見つかったらmovies.tmdb_idに書き戻す(2回目以降は検索なしですぐ返る)。
// こちらはTV版の検索エンドポイントを使う。
async function searchTmdbTvId(title: string, year: number | null): Promise<number | null> {
  if (year) {
    const data = await tmdbFetch("/search/tv", {
      query: title, language: "ja-JP", first_air_date_year: String(year),
    });
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let payload: { movie_id?: number; season_number?: number };
  try {
    payload = await req.json();
  } catch {
    return json({ error: "リクエストの形式が正しくありません" }, 400);
  }

  const movieId = Number(payload.movie_id);
  if (!Number.isFinite(movieId)) return json({ error: "movie_idが不正です" }, 400);
  const seasonNumber = payload.season_number != null ? Number(payload.season_number) : null;

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { data: movie, error: movieErr } = await supabase
    .from("movies")
    .select("id, title, release_year, tmdb_id, media_type")
    .eq("id", movieId)
    .single();
  if (movieErr || !movie) return json({ error: "作品が見つかりませんでした" }, 404);

  if (movie.media_type !== "tv") {
    return json({ movie_id: movieId, seasons: [], episodes: [] });
  }

  let tmdbId: number | null = movie.tmdb_id ?? null;
  if (!tmdbId) {
    tmdbId = await searchTmdbTvId(movie.title, movie.release_year);
    if (tmdbId) {
      await supabase.from("movies").update({ tmdb_id: tmdbId }).eq("id", movieId);
    }
  }
  if (!tmdbId) return json({ movie_id: movieId, seasons: [], episodes: [] });

  const details = await tmdbFetch(`/tv/${tmdbId}`, { language: "ja-JP" });
  if (!details) return json({ movie_id: movieId, tmdb_id: tmdbId, seasons: [], episodes: [] });

  const seasons = (details.seasons || [])
    .filter((s: any) => (s.episode_count || 0) > 0)
    .sort((a: any, b: any) => a.season_number - b.season_number)
    .map((s: any) => ({
      season_number: s.season_number,
      name: s.name,
      episode_count: s.episode_count,
    }));

  let episodes: any[] = [];
  if (seasonNumber != null) {
    const seasonData = await tmdbFetch(`/tv/${tmdbId}/season/${seasonNumber}`, { language: "ja-JP" });
    episodes = (seasonData?.episodes || []).map((e: any) => ({
      season_number: seasonNumber,
      episode_number: e.episode_number,
      name: e.name || `第${e.episode_number}話`,
      overview: (e.overview || "").slice(0, 200),
      still_path: e.still_path || null,
      air_date: e.air_date || null,
    }));
  }

  return json({ movie_id: movieId, tmdb_id: tmdbId, seasons, episodes });
});
