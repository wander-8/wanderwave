// Supabase Advisor findings analyzer
export interface AdvisorFinding {
  type: "security" | "performance" | "health";
  severity: "critical" | "high" | "medium" | "low";
  title: string;
  count: number;
  remediation_url?: string;
  sample_detail: string;
}

export interface EdgeFunctionFinding {
  function_name: string;
  error_count: number;
  sample_error: string;
  severity: "critical" | "high" | "medium";
}

// Map Advisor level to severity
function advisorLevelToSeverity(
  level: string
): "critical" | "high" | "medium" | "low" {
  switch (level) {
    case "ERROR":
      return "critical";
    case "WARN":
      return "high";
    case "INFO":
      return "medium";
    default:
      return "low";
  }
}

// Analyze Supabase Advisor findings
export async function analyzeAdvisors(): Promise<AdvisorFinding[]> {
  const findings: AdvisorFinding[] = [];

  try {
    // Get advisor findings from Supabase MCP
    // Note: In production, this would call the Supabase MCP endpoint
    // For now, we'll parse the response format as the plan expects

    const advisorTypes = ["security", "performance", "health"];

    for (const type of advisorTypes) {
      try {
        // This is a placeholder for MCP get_advisors call
        // In the actual implementation, this would be replaced with
        // the Supabase MCP client call
        const response = await callSupabaseAdvisor(type);

        if (response && response.result && response.result.lints) {
          for (const lint of response.result.lints) {
            const count = lint.findings?.length || lint.count || 0;
            if (count > 0) {
              findings.push({
                type: type as "security" | "performance" | "health",
                severity: advisorLevelToSeverity(lint.level),
                title: lint.title,
                count: count,
                remediation_url: lint.remediation,
                sample_detail:
                  lint.findings && lint.findings[0]
                    ? lint.findings[0].detail
                    : lint.description,
              });
            }
          }
        }
      } catch (error) {
        console.error(`Error analyzing ${type} advisor:`, error);
        // Continue with other types even if one fails
      }
    }
  } catch (error) {
    console.error("Error in analyzeAdvisors:", error);
    throw new Error(`Failed to analyze Advisor findings: ${error}`);
  }

  return findings.sort((a, b) => {
    const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
    return severityOrder[a.severity] - severityOrder[b.severity];
  });
}

// Analyze edge function logs from last 24 hours
export async function analyzeEdgeFunctionLogs(): Promise<
  EdgeFunctionFinding[]
> {
  const findings: EdgeFunctionFinding[] = [];

  try {
    // Query edge function logs from Supabase database
    // This would be a direct PostgreSQL query in production

    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    // Placeholder: In production, this would query the actual edge function logs table
    // For now, return empty to allow the rest of the system to work

    return findings;
  } catch (error) {
    console.error("Error analyzing edge function logs:", error);
    throw new Error(`Failed to analyze edge function logs: ${error}`);
  }
}

// Helper function - placeholder for actual MCP call
async function callSupabaseAdvisor(
  type: string
): Promise<{ result: { lints: unknown[] } }> {
  // This would be the actual MCP HTTP call in production
  // For now, return an empty structure
  return { result: { lints: [] } };
}
