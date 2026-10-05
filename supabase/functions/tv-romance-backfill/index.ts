import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// tmdb-discover-drama/tmdb-discover-animeは、TMDbのTV用ジャンル一覧に
// 「恋愛(Romance)」が存在しない(genre id 10749はmovie専用で、/tv/{id}には
// 絶対に返ってこない)ことに気づかず、以前は一件も「恋愛」ジャンルになって
// いなかった(2026-10時点でドラマ+アニメのTVシリーズ7402件中、恋愛はわずか
// 6件。オーナー指摘:「恋愛もので調べても全然ヒットしない」)。discover側は
// 対応済み(新規取り込み分からはTMDbキーワードで恋愛を判定するようになった)
// だが、既存行はこの関数で遡って直す。

const ROMANCE_TAGS = ["感動", "悲しい", "美しい"];

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

function hasRomanceKeyword(keywordNames: string[]): boolean {
  return keywordNames.some((k) =>
    k.includes("romance") || k.includes("romantic") || k.includes("love triangle")
    || k.includes("arranged marriage") || k.includes("unrequited love") || k === "love");
}

Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 50 } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, genre, emotion_tags, tmdb_id")
      .eq("media_type", "tv")
      .not("tmdb_id", "is", null)
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    let updated = 0;
    let checked = 0;
    const todo = (rows || []).filter((m: any) => !(m.genre || []).includes("恋愛"));
    const CONCURRENCY = 3;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (m: any) => {
          checked++;
          const kw = await tmdbFetch(`/tv/${m.tmdb_id}/keywords`, {});
          const keywordNames: string[] = (kw?.results || []).map((k: any) => String(k.name || "").toLowerCase());
          if (!hasRomanceKeyword(keywordNames)) return;

          const genre = [...(m.genre || []), "恋愛"];
          const emotionTags = [...(m.emotion_tags || [])];
          ROMANCE_TAGS.forEach((t) => {
            if (!emotionTags.includes(t) && emotionTags.length < 3) emotionTags.push(t);
          });

          const { error: updateErr } = await supabase
            .from("movies")
            .update({ genre, emotion_tags: emotionTags })
            .eq("id", m.id);
          if (!updateErr) updated++;
        }),
      );
      await sleep(150);
    }

    return new Response(
      JSON.stringify({ offset, limit, fetched: (rows || []).length, checked, updated }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
