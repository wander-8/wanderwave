import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY")!;
const VOYAGE_MODEL = "voyage-3.5-lite";
const DIMENSION = 1024;

// 「かっこいい」のような、手作業のキーワード辞書(VIBE_QUERY_ALIASES)では
// 追い付かない曖昧な感覚語にも対応したい、というオーナー要望を受けて
// 導入する意味検索(embedding)の第一段階。カタログ全件(movies)の
// 「中身を表す短い文章」をVoyage AIでベクトル化し、movies.embeddingに
// 保存しておく。検索時(voyage-search関数)はクエリも同じモデルで
// ベクトル化し、コサイン類似度が近い作品をpgvectorのHNSWインデックスで
// 高速に引く。独自の意味解析を自前実装するのではなく、検索ツールで
// 広く使われている標準的な手法(埋め込みベクトル+近傍探索)をそのまま
// 採用する(オーナー指摘:「検索ツールでよく搭載されるやり方を踏襲
// すべき」「独自開発せずできる方法があれば」)。

function buildText(row: any): string {
  const parts: string[] = [];
  if (row.title) parts.push(row.title);
  if (Array.isArray(row.genre) && row.genre.length) parts.push(row.genre.join("、"));
  if (row.director) parts.push(row.director);
  if (Array.isArray(row.cast_members) && row.cast_members.length) parts.push(row.cast_members.slice(0, 5).join("、"));
  if (row.country) parts.push(row.country);
  if (Array.isArray(row.emotion_tags) && row.emotion_tags.length) parts.push(row.emotion_tags.join("、"));
  // 音楽はsynopsisが「収録曲数: N曲」のプレースホルダーでしかないため、
  // 中身の文章として意味が無い(むしろ全曲同じ文を埋め込むとノイズになる)。
  // それ以外のmediaは実際のあらすじ(TMDb overview/Rakuten itemCaption)
  // なので、そのまま使う。
  if (row.synopsis && row.media_type !== "music") parts.push(String(row.synopsis).slice(0, 500));
  if (Array.isArray(row.keywords) && row.keywords.length) parts.push(row.keywords.slice(0, 15).join(", "));
  return parts.filter(Boolean).join(" / ").slice(0, 2000);
}

async function embedBatch(texts: string[], inputType: "document" | "query"): Promise<number[][]> {
  const res = await fetch("https://api.voyageai.com/v1/embeddings", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${VOYAGE_API_KEY}`,
    },
    body: JSON.stringify({
      input: texts,
      model: VOYAGE_MODEL,
      input_type: inputType,
      output_dimension: DIMENSION,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`voyage_api_error ${res.status}: ${body}`);
  }
  const data = await res.json();
  return data.data.map((d: any) => d.embedding);
}

function toVectorLiteral(vec: number[]): string {
  return `[${vec.join(",")}]`;
}

Deno.serve(async (req: Request) => {
  try {
    const { batch_rows = 1000, voyage_batch_size = 64 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, title, genre, director, cast_members, country, emotion_tags, synopsis, keywords, media_type")
      .is("embedding", null)
      .order("id", { ascending: true })
      .limit(batch_rows);
    if (error) throw error;

    if (!rows || rows.length === 0) {
      const { count } = await supabase.from("movies").select("id", { count: "exact", head: true }).is("embedding", null);
      return new Response(JSON.stringify({ done: true, remaining: count ?? 0 }), {
        headers: { "Content-Type": "application/json" },
      });
    }

    let embedded = 0;
    for (let i = 0; i < rows.length; i += voyage_batch_size) {
      const chunk = rows.slice(i, i + voyage_batch_size);
      const texts = chunk.map((r: any) => buildText(r) || r.title || "untitled");
      const vectors = await embedBatch(texts, "document");
      const now = new Date().toISOString();
      // upsertはON CONFLICTの前提としてINSERT側のNOT NULL制約(title等)も
      // 評価されてしまう(他カラムを省略した「部分upsert」が通らない)ため、
      // 必ず既存行だけを対象にする素直なUPDATEにする。1件ずつのUPDATEだが、
      // 並列実行することで実用十分な速度に抑える。
      const CONCURRENCY = 16;
      for (let j = 0; j < chunk.length; j += CONCURRENCY) {
        const sub = chunk.slice(j, j + CONCURRENCY);
        const subVectors = vectors.slice(j, j + CONCURRENCY);
        await Promise.all(sub.map((r: any, idx: number) =>
          supabase.from("movies")
            .update({ embedding: toVectorLiteral(subVectors[idx]), embedding_updated_at: now })
            .eq("id", r.id)
        ));
      }
      embedded += chunk.length;
    }

    const { count: remaining } = await supabase.from("movies").select("id", { count: "exact", head: true }).is("embedding", null);

    return new Response(JSON.stringify({ done: false, embedded, remaining: remaining ?? 0 }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
