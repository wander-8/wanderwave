import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// オーナー指示(2026-10-20):「優先順位はユーザーのものにして、そこから
// 実際に扱われる作品の題名もしくはポスターの表現度、そこから先はAI判定
// にする仕組み作って」。表現度の優先順位は
//   ①実投票(movie_review_stats、既存) ②この関数(ポスター画像優先、
//   無ければ題名・あらすじ・ジャンルのテキスト) ③movie_expression_estimates
//   (既存、公式レーティングベースのAI推定)
// の3段階。本関数は②を担当し、movies.poster_expression_level等に結果を
// キャッシュする。全件バックフィルはせず、呼び出し元(index.html側の
// pickOmikujiCandidatesByProfile)が「実際に今日の贈り物の候補として
// 扱った作品」だけを渡す、オンデマンド方式(オーナー選択:「必要になった
// 時だけ」)。
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY")!;
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-haiku-4-5-20251001";
const TMDB_IMAGE_BASE = "https://image.tmdb.org/t/p/w500";

const REASON_TAGS = ["violence", "sexual", "fear", "explicit"];

const tool = {
  name: "estimate_expression_level",
  description: "作品の表現度(暴力・性的・恐怖・露骨な表現の強さ)を、ポスター画像や題名・あらすじから推定する",
  input_schema: {
    type: "object",
    properties: {
      expression_level: {
        type: "integer",
        description: "0〜100の表現度。0に近いほど控えめ、100に近いほど最も強い表現。判断材料が乏しい場合は低め(控えめ側)に倒す。",
      },
      reason_tags: {
        type: "array",
        items: { type: "string", enum: REASON_TAGS },
        maxItems: 4,
        description: "判定の根拠になった表現の種類(0〜4個、無ければ空配列)。音楽作品はexplicitのみを検討する。",
      },
    },
    required: ["expression_level", "reason_tags"],
  },
};

Deno.serve(async (req: Request) => {
  try {
    const { movie_ids, write = true } = await req.json().catch(() => ({}));
    if (!Array.isArray(movie_ids) || !movie_ids.length) {
      return new Response(JSON.stringify({ error: "movie_ids (non-empty array) is required" }), { status: 400 });
    }
    const supabase = createClient(SUPABASE_URL, SERVICE_ROLE);

    const { data: rows, error } = await supabase
      .from("movies")
      .select("id, title, synopsis_excerpt, genre, poster_path, is_music, poster_expression_checked_at")
      .in("id", movie_ids.slice(0, 20)); // 呼び出し元は少数(今日の贈り物の候補)のみ渡す想定。念のため上限を置く。
    if (error) throw error;

    // 既にキャッシュ済みのものは再判定しない(「必要になった時だけ」計算、
    // 同じ作品への重複課金を避ける)。
    const todo = (rows || []).filter((r: any) => !r.poster_expression_checked_at);

    const results: any[] = [];
    for (const m of todo) {
      try {
        const posterUrl = m.poster_path
          ? (String(m.poster_path).startsWith("http") ? m.poster_path : `${TMDB_IMAGE_BASE}${m.poster_path}`)
          : null;

        const userContent: any[] = [];
        if (posterUrl) {
          userContent.push({ type: "image", source: { type: "url", url: posterUrl } });
        }
        const textParts = [`作品名: ${m.title}`];
        if (m.genre?.length) textParts.push(`ジャンル: ${m.genre.join("、")}`);
        if (m.synopsis_excerpt) textParts.push(`あらすじ: ${m.synopsis_excerpt}`);
        if (m.is_music) textParts.push("(この作品は音楽作品です。歌詞そのものは渡していません)");
        userContent.push({ type: "text", text: textParts.join("\n") });

        const res = await fetch(ANTHROPIC_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01" },
          body: JSON.stringify({
            model: MODEL,
            max_tokens: 300,
            system:
              "あなたは作品の表現の強さ(暴力・性的・恐怖・露骨な表現)を、実際には視聴/閲読せずに" +
              "ポスター画像の雰囲気や題名・あらすじ・ジャンルから推定するアシスタントです。断定せず、" +
              "見た目や題材から妥当な範囲で推定してください。判断材料が乏しい場合は控えめな値にしてください。" +
              "estimate_expression_levelツールを必ず1回呼んでください。",
            messages: [{ role: "user", content: userContent }],
            tools: [tool],
            tool_choice: { type: "tool", name: "estimate_expression_level" },
          }),
        });
        if (!res.ok) {
          console.error(`Anthropic API error for movie ${m.id}: ${res.status} ${await res.text()}`);
          continue;
        }
        const data = await res.json();
        const toolUse = (data?.content || []).find((c: any) => c.type === "tool_use" && c.name === "estimate_expression_level");
        if (!toolUse) {
          console.error(`No tool_use in Anthropic response for movie ${m.id}: ${JSON.stringify(data).slice(0, 300)}`);
          continue;
        }
        const level = Math.max(0, Math.min(100, Math.round(Number(toolUse.input?.expression_level) || 0)));
        const tags = (toolUse.input?.reason_tags || []).filter((t: string) => REASON_TAGS.includes(t));

        if (write) {
          await supabase
            .from("movies")
            .update({
              poster_expression_level: level,
              poster_expression_reason_tags: tags,
              poster_expression_checked_at: new Date().toISOString(),
            })
            .eq("id", m.id);
        }
        results.push({ movie_id: m.id, title: m.title, expression_level: level, reason_tags: tags, used_poster: !!posterUrl });
      } catch (err) {
        console.error(`movie ${m.id} failed`, err);
      }
    }

    return new Response(
      JSON.stringify({ requested: movie_ids.length, skipped_cached: (rows || []).length - todo.length, processed: results.length, results }),
      { headers: { "Content-Type": "application/json" } },
    );
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || String(err), stack: err?.stack }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
});
