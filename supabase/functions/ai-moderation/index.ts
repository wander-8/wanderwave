import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const anthropicApiKey = Deno.env.get("ANTHROPIC_API_KEY");
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { review_text, movie_review_id } = await req.json();

    if (!review_text || review_text.trim().length === 0) {
      return new Response(
        JSON.stringify({ severity: "none", ai_verdict: "empty_content" }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Claude API でモデレーション
    const moderationPrompt = `以下のレビュー投稿を審査してください。

投稿内容:
"""
${review_text}
"""

以下の観点から評価してください:
1. 違法/危険な内容（暴力的脅迫、自殺助長など）
2. ハラスメス・いじめ（個人名指し、人格攻撃）
3. 差別・偏見（人種、宗教、性別など）
4. スパム・宣伝（過度なURL、商業宣伝）
5. ミスリード・陰謀論（根拠なき主張）
6. 悪意のある評価（出演者への攻撃など）

評価結果をJSON形式で以下のように返してください:
{
  "severity": "none" | "warn" | "block",
  "violation_types": ["type1", "type2"],
  "flagged_words": ["word1", "word2"],
  "reasoning": "判定理由"
}

severity の定義:
- "none": 問題なし
- "warn": 見直しを促す（ネガティブだが許容範囲）
- "block": 投稿をブロック（違法・ハラスメス・差別など）`;

    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": anthropicApiKey,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-3-5-sonnet-20241022",
        max_tokens: 500,
        messages: [
          {
            role: "user",
            content: moderationPrompt,
          },
        ],
      }),
    });

    const result = await response.json();
    let moderationResult;

    try {
      const content = result.content[0]?.text || "";
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      moderationResult = jsonMatch ? JSON.parse(jsonMatch[0]) : { severity: "error" };
    } catch {
      moderationResult = { severity: "error", reasoning: "Failed to parse AI response" };
    }

    // ログを保存
    const { error: logError } = await supabase.from("review_moderation_logs").insert({
      movie_review_id,
      review_text: review_text.substring(0, 1000),
      severity: moderationResult.severity,
      ai_verdict: JSON.stringify(moderationResult),
      violation_type: moderationResult.violation_types?.[0],
      flagged_words: moderationResult.flagged_words || [],
    });

    if (logError) console.error("Failed to log moderation:", logError);

    return new Response(JSON.stringify(moderationResult), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Moderation error:", error);
    return new Response(
      JSON.stringify({ error: error.message, severity: "error" }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" }, status: 500 }
    );
  }
});
