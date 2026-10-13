import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const TMDB_KEY = Deno.env.get("TMDB_API_KEY")!;
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// 「ハートの数」(Wander独自の愛度)とは完全に別物として、TMDBの評価
// (vote_average/vote_count)を横に並べて見せるバッジ用の穴埋め(オーナー:
// 「本物のWanderのハート数はそのまま残し、TMDBの評価は横に明確に分けた
// バッジとして表示してください」)。対象はTMDBがカバーするmovie/tvのみ
// (音楽・小説・漫画はTMDB管轄外で、tmdb_idが入っていても別経由の誤データ
// の可能性があるため対象にしない)。他のbackfillと同じく、tmdb_vote_checked_at
// が立っていない行だけを少しずつ処理する自己完結型のバックフィル。

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
      if (res.status === 404) return { __not_found: true };
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

Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 100 } = await req.json().catch(() => ({}));

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: movies, error } = await supabase
      .from("movies")
      .select("id, media_type, tmdb_id")
      .in("media_type", ["movie", "tv"])
      .not("tmdb_id", "is", null)
      .is("tmdb_vote_checked_at", null)
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;

    let updated = 0;
    let notFound = 0;
    const CONCURRENCY = 5;
    const todo = movies || [];
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      await Promise.all(
        chunk.map(async (m: any) => {
          const endpoint = m.media_type === "tv" ? "/tv" : "/movie";
          const data = await tmdbFetch(`${endpoint}/${m.tmdb_id}`, { language: "ja-JP" });

          const voteAverage = typeof data?.vote_average === "number" ? data.vote_average : null;
          const voteCount = typeof data?.vote_count === "number" ? data.vote_count : null;
          // 票数0件は「評価が存在する」とは言えない(平均値が意味を持たない)
          // ので、バッジ自体を出さないようnullのままにする。
          const hasVotes = voteAverage != null && voteCount != null && voteCount > 0;
          if (!hasVotes) notFound++;
          else updated++;

          await supabase
            .from("movies")
            .update({
              tmdb_vote_average: hasVotes ? Math.round(voteAverage * 10) / 10 : null,
              tmdb_vote_count: hasVotes ? voteCount : null,
              tmdb_vote_checked_at: new Date().toISOString(),
            })
            .eq("id", m.id);
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
