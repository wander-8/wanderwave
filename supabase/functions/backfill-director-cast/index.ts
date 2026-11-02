import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;

// GitHub Actions auto-deployment with corrected Project ID
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

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

  const { media_type = "movie", limit = 100, dry_run = false } = await req.json().catch(() => ({}));

  // Find movies with missing director/cast (must have tmdb_id)
  const { data: movies, error } = await supabase
    .from("movies")
    .select("id, title, release_year, tmdb_id, media_type")
    .eq("media_type", media_type)
    .or(`director.is.null,cast_members.is.null`)
    .not("tmdb_id", "is", null)
    .limit(limit);

  if (error) throw error;

  const updated: any[] = [];
  const failed: any[] = [];
  const skipped: any[] = [];

  for (const movie of movies || []) {
    try {
      const [details, credits] = await Promise.all([
        tmdbFetch(`/movie/${movie.tmdb_id}`, { language: "ja-JP" }),
        tmdbFetch(`/movie/${movie.tmdb_id}/credits`, { language: "ja-JP" }),
      ]);

      if (!credits) {
        failed.push({ id: movie.id, title: movie.title, reason: "credits_fetch_failed" });
        continue;
      }

      const directors = (credits?.crew || [])
        .filter((c: any) => c.job === "Director")
        .map((c: any) => c.name);

      const cast = (credits?.cast || [])
        .slice(0, 5)
        .map((c: any) => c.name);

      const update: any = {};
      if (!movie.director && directors.length > 0) {
        update.director = directors.join("、") || null;
      }
      if (!movie.cast_members && cast.length > 0) {
        update.cast_members = cast;
      }

      if (Object.keys(update).length > 0) {
        if (!dry_run) {
          const { error: updateError } = await supabase
            .from("movies")
            .update(update)
            .eq("id", movie.id);

          if (updateError) throw updateError;
        }

        updated.push({ id: movie.id, title: movie.title, ...update });
      } else {
        skipped.push({ id: movie.id, title: movie.title, reason: "no_new_data" });
      }

      await sleep(50);
    } catch (err) {
      failed.push({ id: movie.id, title: movie.title, error: err.message });
    }
  }

  return new Response(
    JSON.stringify({
      summary: { total: movies?.length || 0, updated: updated.length, failed: failed.length, skipped: skipped.length },
      updated,
      failed,
      skipped,
      dry_run,
    }),
    { headers: { "Content-Type": "application/json" } }
  );
});
