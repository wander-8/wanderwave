import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// オーナー指摘(2026-10-22、design spec コンポーネントA-4):Rakuten由来
// (novel/manga)はAniList/TMDBのような既製の細かいタグが無いため、この
// 関数だけが新規のAI分類を行う。「男性妊娠」のように作品ごとに違う語を
// 返してよい、オープンエンドな語彙(感情タグのような固定10語ではない)。
// 新規作品のinsert直後に呼ばれる想定だが、既存行のバックフィル用途にも
// offset/limit/writeの引数で流用できるようにしておく(omdb-poster-backfill
// と同じパターン)。
const TOOL = {
  name: "classify_content",
  description: "作品のあらすじ全文から、検索で見つけたい人がいそうな具体的な設定・トロープを抽き出す。",
  input_schema: {
    type: "object",
    properties: {
      nicheTags: {
        type: "array",
        items: { type: "string" },
        description: "あらすじに実際に描写されている具体的な設定・トロープを、作品ごとに自由な言葉で。" +
          "固定の選択肢から選ぶのではなく、その作品に実際に当てはまる言葉を考えて書く" +
          "(例:「男性妊娠」「四肢欠損のあるキャラクター」「年の差カップル」)。" +
          "何も特筆すべき設定が無ければ空配列でよい。多くても5個程度に絞る。",
      },
    },
    required: ["nicheTags"],
  },
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

// 戻り値がnullの場合はAnthropic呼び出し自体の失敗(レート制限・一時エラー等)を
// 意味し、本当に「特筆すべき設定が無かった」結果の空配列[]とは区別する
// (レビュー指摘:これを区別しないと一時的な失敗がniche_tags=[]として
// 永続化され、niche_tags IS NULLを対象にした将来の再分類バックフィルから
// 永久に漏れてしまう)。
async function classifyOne(synopsis: string): Promise<string[] | null> {
  const res = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 256,
      system: "あなたは小説・漫画のあらすじから、検索で見つけたい人がいそうな具体的な設定・トロープを抽き出すアシスタントです。classify_contentツールを呼んでください。",
      messages: [{ role: "user", content: synopsis }],
      tools: [TOOL],
      tool_choice: { type: "tool", name: "classify_content" },
    }),
  });
  if (!res.ok) {
    const bodyText = await res.text().catch(() => "");
    console.error(`classifyOne failed: status=${res.status} body=${bodyText.slice(0, 500)}`);
    return null;
  }
  const data = await res.json();
  const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "classify_content");
  if (!toolUse) return null;
  const tags = toolUse.input?.nicheTags;
  return Array.isArray(tags) ? tags.filter((t: unknown): t is string => typeof t === "string").slice(0, 5) : [];
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders() });
  try {
    // items: [{ movie_id, synopsis }] の配列。複数件まとめて1リクエストで
    // 受け付けられるようにしておく(discover function側から挿入直後に
    // まとめて呼べるように。1件ずつ別リクエストにすると新規作品が多い日に
    // 呼び出し回数が増えてしまう)。
    // backfill: true の場合はitemsを渡す代わりに、niche_tags未設定の既存行を
    // このエンドポイント自身がservice role経由で取得する(オーナー指摘:
    // 2026-10-23「ホーム検索で四肢欠損と検索しても何も出ない」。rakuten-discover-*
    // への組み込みは新規insert分だけが対象で、取り込み済みの約25,000件の
    // 既存小説・漫画行(Rakuten由来、既製タグが無い)には遡及適用されていな
    // かったことが原因と判明。呼び出し側(私)がSELECTのtimeoutに悩まされた
    // ため、SELECT自体をservice role権限でこちらに寄せる)。毎回「niche_tags
    // IS NULL」の先頭からlimit件を取るだけなので、書き込み済みの行は次回の
    // 取得から自然に外れ、offset引数は不要(呼び出し側はwrite:trueのまま
    // 同じリクエストを処理が尽きる=processed:0になるまで繰り返せばよい)。
    const { items = [], write = true, backfill = false, mediaTypes = ["novel", "manga"], limit = 30 } = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    let targets = items;
    if (backfill) {
      const { data, error } = await supabase
        .from("movies")
        .select("id, synopsis")
        .is("niche_tags", null)
        .not("synopsis", "is", null)
        .neq("synopsis", "")
        .in("media_type", mediaTypes)
        .order("id", { ascending: true })
        .limit(limit);
      if (error) throw error;
      targets = (data || []).map((r: any) => ({ movie_id: r.id, synopsis: r.synopsis }));
    }

    const results = [];
    for (const item of targets) {
      const synopsis = (item.synopsis || "").trim();
      if (!synopsis) {
        results.push({ movie_id: item.movie_id, nicheTags: [] });
        continue;
      }
      const nicheTags = await classifyOne(synopsis);
      if (nicheTags === null) {
        // 呼び出し失敗。niche_tags列は書かずに残す(NULLのまま)ことで、
        // 次回のniche_tags IS NULLバックフィルで再度対象になるようにする。
        results.push({ movie_id: item.movie_id, nicheTags: null, error: true });
        continue;
      }
      if (write && item.movie_id) {
        await supabase.from("movies").update({ niche_tags: nicheTags }).eq("id", item.movie_id);
      }
      results.push({ movie_id: item.movie_id, nicheTags });
    }

    return new Response(JSON.stringify({ processed: results.length, results }), {
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (err: any) {
    // このエンドポイントの失敗が呼び出し元(rakuten-discover-*)のinsert自体を
    // 道連れにしてはいけない(design spec/Review Focus参照)。呼び出し元は
    // このレスポンスの成否に関わらず、自分のinsertは既に完了させた後で
    // これを呼ぶこと。
    return new Response(JSON.stringify({ error: err?.message || String(err) }), {
      status: 500,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  }
});
