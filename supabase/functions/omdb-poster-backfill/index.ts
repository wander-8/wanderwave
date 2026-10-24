import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// オーナー指摘(2026-10-21):「The Kat's Meowってやつ、IMDBなら作品情報あったし
// ポスターもあるし評価も貼ってあるよ。使えば？」。実際にTMDB側を確認したところ
// (tmdb-lookupでids=941724を直接取得)、この作品はTMDBに登録はあるが
// poster_path自体がnull、overviewも"Cartoon short."という一文だけだった
// (バックフィル処理のバグではなく、TMDB側のデータが薄いだけ)。同様に
// tmdb_idがあるのにposter_pathが無い映画が914件存在する。IMDBは公式の無料
// APIを提供していないため、IMDBのデータを正規にライセンスして提供している
// OMDb API(https://omdbapi.com)経由でポスターだけを埋める(無料キーは
// 1日1000回まで、914件なら1日で収まる)。
// スコープはポスターのみ(オーナーの依頼通り)。あらすじの上書きはしない
// (既存のTMDB由来テキストを勝手に消さない、別途要望があれば対応する)。
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const OMDB_API_KEY = Deno.env.get("OMDB_API_KEY")!;
const OMDB_ENDPOINT = "https://www.omdbapi.com/";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function omdbFetch(params: Record<string, string>) {
  const url = new URL(OMDB_ENDPOINT);
  url.searchParams.set("apikey", OMDB_API_KEY);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url.toString());
      if (res.ok) return await res.json();
      if (res.status === 429) {
        await sleep(2000);
        continue;
      }
      return { error: true, status: res.status, body: await res.text() };
    } catch {
      await sleep(500 * (attempt + 1));
    }
  }
  return null;
}

function isUsablePoster(poster: string | null | undefined): boolean {
  return !!poster && poster !== "N/A" && /^https?:\/\//.test(poster);
}

Deno.serve(async (req: Request) => {
  try {
    const { offset = 0, limit = 30, write = false } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data, error } = await supabase
      .from("movies")
      .select("id, title, release_year")
      .eq("media_type", "movie")
      .not("tmdb_id", "is", null)
      .is("poster_path", null)
      .order("id", { ascending: true })
      .range(offset, offset + limit - 1);
    if (error) throw error;
    const todo = data || [];

    const results: any[] = [];
    const CONCURRENCY = 3;
    for (let i = 0; i < todo.length; i += CONCURRENCY) {
      const chunk = todo.slice(i, i + CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (m: any) => {
          const params: Record<string, string> = { t: m.title };
          if (m.release_year) params.y = String(m.release_year);
          const data = await omdbFetch(params);
          if (!data || data.error || data.Response !== "True") {
            return { movie_id: m.id, title: m.title, found: false, omdb_error: data?.Error, http_status: data?.status, http_body: data?.body };
          }
          const usable = isUsablePoster(data.Poster);
          if (usable && write) {
            await supabase.from("movies").update({ poster_path: data.Poster }).eq("id", m.id);
          }
          return { movie_id: m.id, title: m.title, found: usable, poster: usable ? data.Poster : null, imdb_rating: data.imdbRating };
        }),
      );
      results.push(...chunkResults);
      await sleep(250);
    }

    return new Response(
      JSON.stringify({ offset, limit, write, processed: results.length, found: results.filter((r) => r.found).length, results }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
