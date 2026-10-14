import "jsr:@supabase/functions-js/edge-runtime.d.ts";

// オーナー指摘:「診断内容をもっと面白くしたい。作品の内容や雰囲気から似てる点を
// 見つけて提示して欲しい。性格診断テストのようなイメージ。作品の共通点を思想や
// 世界観などから形成していくイメージ」。
// 既存のgenerateMonthlyDiagnosis()(index.html)は感情タグの頻度集計だけの
// テンプレート文章で、作品の中身(あらすじ・ジャンル・キーワード)を一切見て
// いなかった。ai-search関数と同じ構成(Anthropic API、tool-useで構造化出力)で、
// 実際に選ばれた作品の中身からAIに共通点を書かせる。
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type MovieInput = {
  title?: string;
  mediaTypeLabel?: string;
  synopsis?: string;
  genre?: string[];
  keywords?: string[];
  emotionTags?: string[];
};

type RequestBody = {
  movies?: MovieInput[];
  milestone?: number;
  usualTopTagLabel?: string;
};

function buildMovieBlock(m: MovieInput, idx: number): string {
  const lines = [`${idx + 1}. 「${(m.title || "").slice(0, 60)}」(${m.mediaTypeLabel || "作品"})`];
  if (m.genre && m.genre.length) lines.push(`   ジャンル: ${m.genre.slice(0, 5).join("、")}`);
  if (m.emotionTags && m.emotionTags.length) lines.push(`   雰囲気タグ: ${m.emotionTags.slice(0, 4).join("、")}`);
  if (m.synopsis) lines.push(`   あらすじ: ${m.synopsis.slice(0, 280)}`);
  if (m.keywords && m.keywords.length) lines.push(`   キーワード: ${m.keywords.slice(0, 8).join("、")}`);
  return lines.join("\n");
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };
  try {
    const body: RequestBody = await req.json().catch(() => ({}));
    const movies = Array.isArray(body.movies) ? body.movies.slice(0, 10) : [];
    const milestone = typeof body.milestone === "number" ? body.milestone : null;
    const usualTopTagLabel = typeof body.usualTopTagLabel === "string" ? body.usualTopTagLabel : "";

    if (!movies.length) {
      return new Response(JSON.stringify({ error: "movies is required" }), { status: 400, headers: jsonHeaders });
    }
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on this project" }),
        { status: 500, headers: jsonHeaders },
      );
    }

    const tool = {
      name: "write_diagnosis",
      description: "選ばれた作品の中身(あらすじ・ジャンル・雰囲気)から共通点を見つけ、性格診断テスト風の結果を書く。",
      input_schema: {
        type: "object",
        properties: {
          themeTitle: {
            type: "string",
            description:
              "この人のタイプを表す、短く印象的な名前(性格診断テストの結果名のような体言止めの" +
              "フレーズ、10〜20字程度。例:「静かな嵐を好む人」「境界線を越えたがる旅人」。" +
              "作品名やジャンル名をそのまま使わず、見つけた共通点を抽象化した独自の表現にする。",
          },
          body: {
            type: "string",
            description:
              "診断本文。350〜550字程度の日本語。選ばれた作品の『あらすじ・ジャンル・雰囲気タグ』を" +
              "実際に読み比べ、そこから見つかる具体的な共通点(例:主人公が一人で何かと向き合う話が" +
              "多い、喪失や別れの後の再生を描く作品が多い、閉ざされた場所や関係からの脱出が繰り返し" +
              "出てくる、等)を根拠にして、性格診断テストのような温かい語り口で書く。『あなたは〜な" +
              "人なのかもしれません』のように余白を残す言い回しにする。良い/悪いの価値判断の言葉、" +
              "および『データ・分析・傾向・パターン・構造』のような分析用語は使わない。作品名を" +
              "そのまま並べるだけの要約にはせず、必ず具体的な共通点の指摘を含める。選ばれた作品の" +
              "うち少なくとも2本のタイトルに触れる。",
          },
        },
        required: ["themeTitle", "body"],
      },
    };

    const systemPrompt = [
      "あなたは映画・アニメ・ドラマ・漫画・小説・音楽の発見サイト「Wander」の診断ライターです。",
      "ユーザーが今回ポケットに入れた作品(今月分)の実際の中身を読み比べ、タグの頻度集計では",
      "見えてこない『作品の内容や雰囲気から見つかる共通点』を性格診断テストのような形で",
      "書いてください。思想・世界観・物語の構造・登場人物の在り方などから、できるだけ具体的な",
      "共通点を見つけること(単に『感動する作品が多い』で終わらせず、なぜ感動するのか・",
      "どんな状況の人物が描かれがちか、まで踏み込む)。",
      "write_diagnosisツールを必ず1回呼んでください。",
      milestone === 10 ? "今月ポケットが10本埋まった、今月最後の診断です。少し締めくくりらしい言葉を添えてよいです。" : "",
    ].filter(Boolean).join("\n");

    const userContent = [
      `今回選ばれた作品(${movies.length}本):`,
      movies.map((m, i) => buildMovieBlock(m, i)).join("\n\n"),
      usualTopTagLabel ? `\nこの人がこれまでポケットに入れてきた作品全体では「${usualTopTagLabel}」の雰囲気が多い傾向があります(参考情報、本文で無理に触れなくてよい)。` : "",
    ].filter(Boolean).join("\n");

    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 700,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
        tools: [tool],
        tool_choice: { type: "tool", name: "write_diagnosis" },
      }),
    });

    if (!res.ok) {
      const errBody = await res.text();
      return new Response(JSON.stringify({ error: "anthropic_api_error", status: res.status, body: errBody }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    const data = await res.json();
    if (data?.usage) {
      console.log("anthropic_usage", JSON.stringify(data.usage));
    }
    const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "write_diagnosis");
    if (!toolUse) {
      return new Response(JSON.stringify({ error: "no_tool_use_in_response", raw: data }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    const input = toolUse.input || {};
    const themeTitle = typeof input.themeTitle === "string" ? input.themeTitle.trim().slice(0, 60) : "";
    const diagnosisBody = typeof input.body === "string" ? input.body.trim().slice(0, 1000) : "";

    if (!themeTitle || !diagnosisBody) {
      return new Response(JSON.stringify({ error: "empty_diagnosis_output", raw: input }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    return new Response(JSON.stringify({ themeTitle, body: diagnosisBody }), { headers: jsonHeaders });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
