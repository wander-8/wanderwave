import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.43.4";
import { analyzeAdvisors, analyzeEdgeFunctionLogs } from "./analyzers.ts";
import { notifySlack } from "./notify.ts";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL") || "",
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || ""
);

interface DetectionResponse {
  success: boolean;
  detected_count: number;
  advisors: { security: number; performance: number };
  edge_function_errors: number;
  message: string;
  errors?: string[];
}

async function performDailyDetection(): Promise<DetectionResponse> {
  const response: DetectionResponse = {
    success: true,
    detected_count: 0,
    advisors: { security: 0, performance: 0 },
    edge_function_errors: 0,
    message: "Detection initiated",
    errors: [],
  };

  try {
    console.log("Starting daily bug detection...");

    // Step 1: Analyze Advisors
    let advisorFindings = [];
    try {
      advisorFindings = await analyzeAdvisors();
      response.advisors.security = advisorFindings.filter(
        (f) => f.type === "security"
      ).length;
      response.advisors.performance = advisorFindings.filter(
        (f) => f.type === "performance"
      ).length;
      console.log(`Found ${advisorFindings.length} advisor findings`);
    } catch (error) {
      const errorMsg = `Advisor analysis failed: ${error}`;
      console.error(errorMsg);
      response.errors?.push(errorMsg);
    }

    // Step 2: Analyze Edge Function Logs
    let edgeFunctionFindings = [];
    try {
      edgeFunctionFindings = await analyzeEdgeFunctionLogs();
      response.edge_function_errors = edgeFunctionFindings.length;
      console.log(`Found ${edgeFunctionFindings.length} edge function errors`);
    } catch (error) {
      const errorMsg = `Edge function log analysis failed: ${error}`;
      console.error(errorMsg);
      response.errors?.push(errorMsg);
    }

    // Step 3: Insert into database
    const allFindings = [
      ...advisorFindings.map((f) => ({
        type: f.type,
        severity: f.severity,
        title: f.title,
        description: f.sample_detail,
        remediation_url: f.remediation_url,
        is_fixed: false,
      })),
      ...edgeFunctionFindings.map((f) => ({
        type: "edge_function_error",
        severity: f.severity,
        title: `Error in ${f.function_name}`,
        description: f.sample_error,
        remediation_url: null,
        is_fixed: false,
      })),
    ];

    let inserted = 0;
    for (const finding of allFindings) {
      try {
        // Check for duplicates (same type, title, is_fixed=false from today)
        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const { data: existing, error: checkError } = await supabase
          .from("bug_detection_log")
          .select("id")
          .eq("type", finding.type)
          .eq("title", finding.title)
          .eq("is_fixed", false)
          .gte("detected_at", today.toISOString())
          .limit(1);

        if (checkError) {
          console.error("Error checking for duplicates:", checkError);
          continue;
        }

        // Only insert if not already present today
        if (!existing || existing.length === 0) {
          const { error: insertError } = await supabase
            .from("bug_detection_log")
            .insert([finding]);

          if (insertError) {
            console.error("Error inserting finding:", insertError);
          } else {
            inserted++;
          }
        }
      } catch (error) {
        console.error("Error processing finding:", error);
      }
    }

    response.detected_count = inserted;
    console.log(`Inserted ${inserted} new findings into database`);

    // Step 4: Send Slack notification
    const slackSuccess = await notifySlack(advisorFindings, edgeFunctionFindings);
    if (!slackSuccess) {
      const errorMsg = "Slack notification failed";
      console.error(errorMsg);
      response.errors?.push(errorMsg);
    }

    response.message = `Detection completed: ${allFindings.length} findings detected, ${inserted} new`;
    response.success = (response.errors?.length || 0) === 0;

    console.log("Daily bug detection completed successfully");
  } catch (error) {
    console.error("Fatal error in daily detection:", error);
    response.success = false;
    response.message = `Fatal error: ${error}`;
  }

  return response;
}

serve(async (req) => {
  // Only accept POST requests
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), {
      status: 405,
      headers: { "Content-Type": "application/json" },
    });
  }

  try {
    const result = await performDailyDetection();

    return new Response(JSON.stringify(result), {
      status: result.success ? 200 : 500,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("Unhandled error:", error);

    return new Response(
      JSON.stringify({
        success: false,
        message: `Unhandled error: ${error}`,
        detected_count: 0,
        advisors: { security: 0, performance: 0 },
        edge_function_errors: 0,
      }),
      {
        status: 500,
        headers: { "Content-Type": "application/json" },
      }
    );
  }
});
