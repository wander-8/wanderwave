import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY");
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";

// ブラウザから直接叩くため、他のクライアント向け関数(submit-contact等)と
// 同じCORSヘッダーが無いとOPTIONSプリフライトで弾かれる。
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// 「AI検索」: ユーザーが自由文(例:「雨の日に見たい泣ける映画」)を入力すると、
// フロント側が今選んでいるカタログモードで実際に選択可能な感情タグ・
// ジャンル・国・年代の一覧をここに渡し、Claudeにその中からだけ選んでもらって
// 既存の絞り込みチップ(activeTags/activeGenres/activeCountries/decadeFilter)
// に自動変換する。新しい検索の仕組みを作るのではなく、既にある「詳しく
// 絞り込む」の操作をAIが代わりにやってくれるだけ、という位置づけ。
// tool_choiceで強制的にツールを呼ばせることで、存在しないジャンル名等を
// でっち上げられないようにする(enumで渡した語彙以外は選べない)。

type RequestBody = {
  query?: string;
  emotionTags?: string[];
  genres?: string[];
  countries?: string[];
  decades?: number[];
};

function sanitizeList(values: unknown, allowed: string[]): string[] {
  if (!Array.isArray(values)) return [];
  const allowedSet = new Set(allowed);
  return values.filter((v): v is string => typeof v === "string" && allowedSet.has(v));
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  const jsonHeaders = { "Content-Type": "application/json", ...corsHeaders };
  try {
    if (!ANTHROPIC_API_KEY) {
      return new Response(
        JSON.stringify({ error: "ANTHROPIC_API_KEY is not configured on this project" }),
        { status: 500, headers: jsonHeaders },
      );
    }

    const body: RequestBody = await req.json().catch(() => ({}));
    const query = (body.query || "").trim();
    const emotionTags = Array.isArray(body.emotionTags) ? body.emotionTags.filter((t) => typeof t === "string") : [];
    const genres = Array.isArray(body.genres) ? body.genres.filter((g) => typeof g === "string") : [];
    const countries = Array.isArray(body.countries) ? body.countries.filter((c) => typeof c === "string") : [];
    const decades = Array.isArray(body.decades) ? body.decades.filter((d) => typeof d === "number") : [];

    if (!query) {
      return new Response(JSON.stringify({ error: "query is required" }), {
        status: 400,
        headers: jsonHeaders,
      });
    }

    const decadeProperty: Record<string, unknown> = decades.length
      ? { type: "integer", enum: decades, description: "最も近い年代。該当が無ければこのフィールド自体を省略する。" }
      : { type: "integer", description: "年代の指定が無いので使わない(省略する)。" };

    const tool = {
      name: "apply_filters",
      description: "ユーザーの自由文を、与えられた選択肢の中からだけ選んで既存の絞り込みフィルタに変換する。",
      input_schema: {
        type: "object",
        properties: {
          emotionTags: {
            type: "array",
            items: { type: "string", enum: emotionTags.length ? emotionTags : [""] },
            description: "文章の雰囲気に合う感情タグ。確信が持てるものだけ、最大2〜3個まで。",
          },
          genres: {
            type: "array",
            items: { type: "string", enum: genres.length ? genres : [""] },
            description: "文章で言及・示唆されているジャンル。明確なものだけ。",
          },
          countries: {
            type: "array",
            items: { type: "string", enum: countries.length ? countries : [""] },
            description: "「海外の」「日本の」のように国籍への言及が明確な場合だけ。",
          },
          decade: decadeProperty,
        },
        required: ["emotionTags", "genres", "countries"],
      },
    };

    const systemPrompt = [
      "あなたは映画・アニメ・ドラマ・漫画・小説・音楽の発見サイト「Wander」の検索アシスタントです。",
      "ユーザーが入力した自由な文章から、サイト側で用意された選択肢(感情タグ・ジャンル・国・年代)の中に",
      "明確に当てはまるものだけを選び、apply_filtersツールを呼んでください。",
      "",
      "重要なルール:",
      "- 与えられた選択肢に無い値は絶対に作らない(enumに存在するものだけを選ぶ)。",
      "- 文章から確信を持って読み取れないものは、無理に埋めずそのフィールドを空(または省略)にする。",
      "  例えば「何か面白いの無い?」のような曖昧な文章では、ほとんど何も選ばなくてよい。",
      "- 感情タグは最大2〜3個まで。選びすぎて絞り込みすぎないようにする。",
      "- 年代は「80年代の」「最近の」のように時代への言及が明確な時だけ選ぶ。",
      "",
      `選べる感情タグ: ${emotionTags.join("、") || "(なし)"}`,
      `選べるジャンル: ${genres.join("、") || "(なし)"}`,
      `選べる国: ${countries.join("、") || "(なし)"}`,
      `選べる年代: ${decades.map((d) => `${d}年代`).join("、") || "(なし)"}`,
    ].join("\n");

    const res = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 512,
        system: systemPrompt,
        messages: [{ role: "user", content: query }],
        tools: [tool],
        tool_choice: { type: "tool", name: "apply_filters" },
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
    const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "apply_filters");
    if (!toolUse) {
      return new Response(JSON.stringify({ error: "no_tool_use_in_response", raw: data }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    const input = toolUse.input || {};
    const resultEmotionTags = sanitizeList(input.emotionTags, emotionTags);
    const resultGenres = sanitizeList(input.genres, genres);
    const resultCountries = sanitizeList(input.countries, countries);
    const resultDecade = typeof input.decade === "number" && decades.includes(input.decade) ? input.decade : null;

    return new Response(
      JSON.stringify({
        emotionTags: resultEmotionTags,
        genres: resultGenres,
        countries: resultCountries,
        decade: resultDecade,
      }),
      { headers: jsonHeaders },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
});
