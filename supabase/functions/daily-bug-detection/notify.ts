import { AdvisorFinding, EdgeFunctionFinding } from "./analyzers.ts";

export async function notifySlack(
  advisorFindings: AdvisorFinding[],
  edgeFunctionFindings: EdgeFunctionFinding[]
): Promise<boolean> {
  const webhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");

  if (!webhookUrl) {
    console.error("SLACK_WEBHOOK_URL not configured");
    return false;
  }

  try {
    // Group findings by type
    const securityFindings = advisorFindings.filter((f) => f.type === "security");
    const performanceFindings = advisorFindings.filter(
      (f) => f.type === "performance"
    );

    // Format Slack message in Japanese
    const dateJST = new Date(
      new Date().getTime() + 9 * 60 * 60 * 1000
    ).toLocaleDateString("ja-JP");
    const timeJST = new Date(
      new Date().getTime() + 9 * 60 * 60 * 1000
    ).toLocaleTimeString("ja-JP");

    let message = `🐛 *[Wander_Wave] 日次バグ検出* - ${dateJST} ${timeJST}\n\n`;

    // Security findings
    if (securityFindings.length > 0) {
      message += `*セキュリティ警告* (${securityFindings.length}件):\n`;
      securityFindings.slice(0, 5).forEach((f) => {
        message += `  • *${f.title}*: ${f.count} findings\n`;
      });
      message += "\n";
    }

    // Performance findings
    if (performanceFindings.length > 0) {
      message += `*パフォーマンス警告* (${performanceFindings.length}件):\n`;
      performanceFindings.slice(0, 5).forEach((f) => {
        message += `  • *${f.title}*: ${f.count} findings\n`;
      });
      message += "\n";
    }

    // Edge function errors
    if (edgeFunctionFindings.length > 0) {
      message += `*エッジ関数エラー* (${edgeFunctionFindings.length}件):\n`;
      edgeFunctionFindings.slice(0, 5).forEach((f) => {
        message += `  • *${f.function_name}*: ${f.error_count} errors (last 24h)\n`;
      });
      message += "\n";
    }

    // Summary
    const totalCount =
      advisorFindings.length + edgeFunctionFindings.length;
    message += `*合計*: ${totalCount}件検出\n\n`;
    message += `詳細: https://wander-8.site/dashboard#bugs`;

    // Send to Slack
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: message,
        blocks: [
          {
            type: "section",
            text: {
              type: "mrkdwn",
              text: message,
            },
          },
        ],
      }),
    });

    if (!response.ok) {
      const responseText = await response.text();
      console.error(
        `Slack webhook failed: ${response.status} ${responseText}`
      );

      // Handle specific error codes
      if (response.status === 401 || response.status === 403) {
        console.error(
          "Webhook token may be expired or invalid. Please update SLACK_WEBHOOK_URL."
        );
      } else if (response.status >= 500) {
        console.error("Slack service temporarily unavailable");
      }

      return false;
    }

    return true;
  } catch (error) {
    console.error("Error sending Slack notification:", error);
    return false;
  }
}

// Test webhook connectivity
export async function testSlackWebhook(): Promise<boolean> {
  const webhookUrl = Deno.env.get("SLACK_WEBHOOK_URL");

  if (!webhookUrl) {
    console.error("SLACK_WEBHOOK_URL not configured");
    return false;
  }

  try {
    const response = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: "🐛 Wander_Wave Bug Detection System - Webhook Test (接続テスト)",
      }),
    });

    return response.ok;
  } catch (error) {
    console.error("Webhook test failed:", error);
    return false;
  }
}
