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
import { tokenStore } from "../auth/token-store.js";
import { getSupabaseClient } from "../db/supabase.js";

const analyticsLogger = createLogger({ component: "tools" });

// 90 days TTL for analytics records
const ANALYTICS_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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
  structuredContent?: unknown;
  isError?: boolean;
}

/**
 * Context for analytics tracking
 */
interface AnalyticsContext {
  mcpAccessToken: string;
  sessionId?: string;
}

/**
 * Analytics record for Supabase persistence
 */
interface AnalyticsRecord {
  withings_user_id: string;
  tool_name: string;
  success: boolean;
  duration_ms: number;
  error_category?: string;
  date_range_days?: number;
  mcp_session_id?: string;
  invoked_at: string;
  expires_at: string;
}

/**
 * Persist analytics to Supabase (fire-and-forget)
 * Does not block the tool response - errors are logged but not thrown
 */
async function persistAnalytics(record: AnalyticsRecord): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const { error } = await supabase.from("tool_analytics").insert(record);

    if (error) {
      analyticsLogger.warn("Failed to persist analytics", {
        error: error.message,
        tool: record.tool_name,
      });
    }
  } catch (err) {
    analyticsLogger.warn("Analytics persistence error", {
      error: err instanceof Error ? err.message : String(err),
      tool: record.tool_name,
    });
  }
}

/**
 * Wrap a tool handler with analytics logging.
 * Logs tool name, execution duration, success/failure, error category, and date range span.
 * All logged data is privacy-safe (no actual dates, tokens, or user data).
 *
 * Analytics are:
 * 1. Logged to stdout (real-time, for monitoring)
 * 2. Persisted to Supabase (async, fire-and-forget, for per-user insights)
 *
 * On error, returns an MCP-compatible error response instead of throwing.
 *
 * @param toolName - Name of the tool being invoked
 * @param handler - The async handler function to wrap
 * @param context - Analytics context with mcpAccessToken and optional sessionId
 * @param args - Optional tool arguments (used to extract date range span)
 * @returns The handler result, or an error response on failure
 */
export async function withAnalytics(
  toolName: string,
  handler: () => Promise<ToolResponse>,
  context: AnalyticsContext,
  args?: Record<string, any>
): Promise<ToolResponse> {
  const startTime = performance.now();
  const invokedAt = new Date().toISOString();
  const expiresAt = new Date(Date.now() + ANALYTICS_TTL_MS).toISOString();

  // Extract date range span from args (privacy-safe: just the span, not actual dates)
  const dateRangeDays = calculateDateRangeDays(
    args?.startdate || args?.startdateymd,
    args?.enddate || args?.enddateymd
  );

  // Look up withings_user_id from token store
  let withingsUserId: string | undefined;
  try {
    const tokenData = await tokenStore.getTokens(context.mcpAccessToken);
    withingsUserId = tokenData?.withingsUserId;
  } catch {
    // If token lookup fails, continue without user ID
    analyticsLogger.debug("Could not lookup user ID for analytics", {
      tool: toolName,
    });
  }

  try {
    const result = await handler();
    const durationMs = Math.round(performance.now() - startTime);

    // Log to stdout (privacy-safe: no user ID)
    const stdoutAnalytics: Record<string, any> = {
      tool: toolName,
      duration_ms: durationMs,
      success: true,
    };

    if (dateRangeDays !== undefined) {
      stdoutAnalytics.date_range_days = dateRangeDays;
    }

    analyticsLogger.info("tool_analytics", stdoutAnalytics);

    // Persist to Supabase (fire-and-forget, includes user ID)
    if (withingsUserId) {
      const record: AnalyticsRecord = {
        withings_user_id: withingsUserId,
        tool_name: toolName,
        success: true,
        duration_ms: durationMs,
        date_range_days: dateRangeDays,
        mcp_session_id: context.sessionId,
        invoked_at: invokedAt,
        expires_at: expiresAt,
      };
      // Fire-and-forget: don't await
      persistAnalytics(record);
    }

    return result;
  } catch (error) {
    const durationMs = Math.round(performance.now() - startTime);
    const errorCategory = categorizeError(error);

    // Log to stdout (privacy-safe: no user ID)
    const stdoutAnalytics: Record<string, any> = {
      tool: toolName,
      duration_ms: durationMs,
      success: false,
      error_category: errorCategory,
    };

    if (dateRangeDays !== undefined) {
      stdoutAnalytics.date_range_days = dateRangeDays;
    }

    analyticsLogger.info("tool_analytics", stdoutAnalytics);

    // Persist to Supabase (fire-and-forget, includes user ID)
    if (withingsUserId) {
      const record: AnalyticsRecord = {
        withings_user_id: withingsUserId,
        tool_name: toolName,
        success: false,
        duration_ms: durationMs,
        error_category: errorCategory,
        date_range_days: dateRangeDays,
        mcp_session_id: context.sessionId,
        invoked_at: invokedAt,
        expires_at: expiresAt,
      };
      // Fire-and-forget: don't await
      persistAnalytics(record);
    }

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
