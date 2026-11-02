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
  const supabase = createClient(supabaseUrl, supabaseServiceKey);

  try {
    const { user_id, movie_id, review_text } = await req.json();

    const spamIndicators = [];
    let spamScore = 0;

    // 1. URL スパム検出（過度なURL）
    const urlPattern = /(https?:\/\/[^\s]+)/g;
    const urls = review_text.match(urlPattern) || [];
    if (urls.length > 2) {
      spamIndicators.push("excessive_urls");
      spamScore += 0.3;
    }

    // 2. 短時間での大量投稿（スパム投稿）
    const { data: recentReviews } = await supabase
      .from("movie_reviews")
      .select("created_at")
      .eq("user_id", user_id)
      .gte("created_at", new Date(Date.now() - 5 * 60000).toISOString()); // 過去5分

    if ((recentReviews?.length || 0) > 3) {
      spamIndicators.push("rapid_posting");
      spamScore += 0.4;
    }

    // 3. 同じ内容の繰り返し
    const { data: sameContentReviews } = await supabase
      .from("movie_reviews")
      .select("review_text")
      .eq("user_id", user_id)
      .gte("created_at", new Date(Date.now() - 24 * 60 * 60000).toISOString()); // 過去24時間

    const duplicates = sameContentReviews?.filter(
      (r) => r.review_text && similarity(r.review_text, review_text) > 0.9
    ).length || 0;

    if (duplicates > 0) {
      spamIndicators.push("duplicate_content");
      spamScore += 0.5;
    }

    // 4. キーワードスパム（同じ単語の繰り返し）
    const words = review_text.split(/\s+/);
    const wordFreq = new Map();
    words.forEach((w) => {
      wordFreq.set(w, (wordFreq.get(w) || 0) + 1);
    });
    const maxFreq = Math.max(...wordFreq.values());
    if (maxFreq > words.length * 0.4) {
      spamIndicators.push("keyword_repetition");
      spamScore += 0.3;
    }

    // 5. 過度な絵文字
    const emojiPattern = /[\uD800-\uDBFF][\uDC00-\uDFFF]/g;
    const emojis = review_text.match(emojiPattern) || [];
    if (emojis.length > review_text.length * 0.2) {
      spamIndicators.push("excessive_emojis");
      spamScore += 0.2;
    }

    // 6. ユーザー違反履歴
    const { data: violations } = await supabase
      .from("user_violations")
      .select("id")
      .eq("user_id", user_id);

    if ((violations?.length || 0) > 2) {
      spamIndicators.push("repeat_violator");
      spamScore += 0.5;
    }

    // スパムスコアが高い場合、ログに保存
    if (spamScore > 0.5) {
      await supabase.from("spam_detection_logs").insert({
        user_id,
        movie_id,
        spam_indicators: spamIndicators,
        confidence: Math.min(spamScore, 1),
      });
    }

    return new Response(
      JSON.stringify({
        spam_score: Math.min(spamScore, 1),
        spam_indicators: spamIndicators,
        is_spam: spamScore > 0.7,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Spam check error:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
      status: 500,
    });
  }
});

// 文字列の類似度を計算（Jaccard 係数）
function similarity(str1: string, str2: string): number {
  const set1 = new Set(str1.split(""));
  const set2 = new Set(str2.split(""));
  const intersection = new Set([...set1].filter((x) => set2.has(x)));
  const union = new Set([...set1, ...set2]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}
