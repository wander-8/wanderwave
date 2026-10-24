import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY")!;
const VOYAGE_MODEL = "voyage-3.5-lite";
const DIMENSION = 1024;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 意味検索(embedding)の検索側。自由文クエリをvoyage-embed-backfillと同じ
// モデルでベクトル化し(input_type="query"を使う点だけが違う。Voyageは
// 「検索されるドキュメント」と「検索するクエリ」を非対称に最適化できる
// 仕組みを持っており、backfill側は"document"、こちらは"query"を指定する
// のが公式に推奨された使い方)、pgvectorのコサイン類似度で近い作品を
// 返す。カタログモード(映画/アニメ/漫画等)による絞り込みはフロント側の
// 既存ロジック(isInCatalogMode)にそのまま任せるため、ここでは絞らず
// 候補を広め(match_count)に返す。
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };
  try {
    const { query, match_count = 200 } = await req.json().catch(() => ({}));
    const q = typeof query === "string" ? query.trim() : "";
    if (!q) {
      return new Response(JSON.stringify({ error: "query is required" }), { status: 400, headers: jsonHeaders });
    }

    const embedRes = await fetch("https://api.voyageai.com/v1/embeddings", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${VOYAGE_API_KEY}`,
      },
      body: JSON.stringify({
        input: [q],
        model: VOYAGE_MODEL,
        input_type: "query",
        output_dimension: DIMENSION,
      }),
    });
    if (!embedRes.ok) {
      const body = await embedRes.text();
      return new Response(JSON.stringify({ error: "voyage_api_error", status: embedRes.status, body }), {
        status: 502,
        headers: jsonHeaders,
      });
    }
    const embedData = await embedRes.json();
    const vector: number[] = embedData.data[0].embedding;

    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);
    const { data, error } = await supabase.rpc("match_movies_by_embedding", {
      query_embedding: `[${vector.join(",")}]`,
      match_count,
    });
    if (error) throw error;

    return new Response(
      JSON.stringify({ results: (data || []).map((r: any) => ({ id: r.id, similarity: r.similarity })) }),
      { headers: jsonHeaders },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
