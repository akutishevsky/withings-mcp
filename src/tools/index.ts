import { registerSleepTools } from "./sleep.js";
import { registerMeasureTools } from "./measure.js";
import { registerUserTools } from "./user.js";
import { registerHeartTools } from "./heart.js";
import { registerStethoTools } from "./stetho.js";
import {
  createLogger,
  calculateDateRangeDays,
  categorizeError,
} from "../utils/logger.js";

const analyticsLogger = createLogger({ component: "tools" });

/**
 * Register all Withings tools on an MCP server instance
 * @param server - The MCP server instance to register tools on
 * @param mcpAccessToken - The MCP access token for authentication
 */
export function registerAllTools(server: any, mcpAccessToken: string) {
  registerSleepTools(server, mcpAccessToken);
  registerMeasureTools(server, mcpAccessToken);
  registerUserTools(server, mcpAccessToken);
  registerHeartTools(server, mcpAccessToken);
  registerStethoTools(server, mcpAccessToken);
}

/**
 * MCP tool response type
 */
interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

/**
 * Wrap a tool handler with analytics logging.
 * Logs tool name, execution duration, success/failure, error category, and date range span.
 * All logged data is privacy-safe (no actual dates, tokens, or user data).
 *
 * On error, returns an MCP-compatible error response instead of throwing.
 *
 * @param toolName - Name of the tool being invoked
 * @param handler - The async handler function to wrap
 * @param args - Optional tool arguments (used to extract date range span)
 * @returns The handler result, or an error response on failure
 */
export async function withAnalytics(
  toolName: string,
  handler: () => Promise<ToolResponse>,
  args?: Record<string, any>
): Promise<ToolResponse> {
  const startTime = performance.now();

  // Extract date range span from args (privacy-safe: just the span, not actual dates)
  const dateRangeDays = calculateDateRangeDays(
    args?.startdate || args?.startdateymd,
    args?.enddate || args?.enddateymd
  );

  try {
    const result = await handler();
    const durationMs = Math.round(performance.now() - startTime);

    const analytics: Record<string, any> = {
      tool: toolName,
      duration_ms: durationMs,
      success: true,
    };

    if (dateRangeDays !== undefined) {
      analytics.date_range_days = dateRangeDays;
    }

    analyticsLogger.info("tool_analytics", analytics);

    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime);

    const analytics: Record<string, any> = {
      tool: toolName,
      duration_ms: durationMs,
      success: false,
      error_category: categorizeError(error),
    };

    if (dateRangeDays !== undefined) {
      analytics.date_range_days = dateRangeDays;
    }

    analyticsLogger.info("tool_analytics", analytics);

    // Return MCP-compatible error response instead of throwing
    return {
      content: [
        {
          type: "text",
          text: `Error: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      isError: true,
    };
  }
}
