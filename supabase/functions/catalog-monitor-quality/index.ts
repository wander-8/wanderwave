import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
);

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
    });
  }

  try {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);

    // Get today's stats
    const { data: todayData, error: todayError } = await supabase
      .from("catalog_review_log")
      .select("judgment, judgment_confidence")
      .gte("created_at", today.toISOString())
      .lt("created_at", new Date(today.getTime() + 24 * 60 * 60 * 1000).toISOString());

    if (todayError) throw todayError;

    const stats = {
      accept_count: 0,
      reject_count: 0,
      manual_review_count: 0,
      avg_confidence: 0,
      total: todayData?.length || 0,
    };

    if (todayData && todayData.length > 0) {
      for (const item of todayData) {
        if (item.judgment === "accept") stats.accept_count++;
        if (item.judgment === "reject") stats.reject_count++;
        if (item.judgment === "manual_review") stats.manual_review_count++;
      }

      const totalConfidence = todayData.reduce(
        (sum, item) => sum + (item.judgment_confidence || 0),
        0
      );
      stats.avg_confidence = totalConfidence / todayData.length;
    }

    // Send Slack notification
    const webhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");
    if (webhookUrl) {
      const message = `🔍 Catalog Quality Monitor\n\nToday: ${stats.total} works reviewed\n• Accept: ${stats.accept_count}\n• Reject: ${stats.reject_count}\n• Manual Review: ${stats.manual_review_count}\n• Avg Confidence: ${stats.avg_confidence.toFixed(2)}`;

      await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
    }

    return new Response(
      JSON.stringify({ success: true, stats }),
      { status: 200, headers: { "Content-Type": "application/json" } }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({ success: false, error: String(error) }),
      { status: 500, headers: { "Content-Type": "application/json" } }
    );
  }
});
