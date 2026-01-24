import { getSupabaseClient } from "./supabase.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "cleanup" });

/**
 * Clean up expired records from all tables
 */
export async function cleanupExpiredRecords(): Promise<void> {
  const supabase = getSupabaseClient();
  const now = new Date().toISOString();

  logger.info("Starting cleanup of expired records");

  // Clean up expired OAuth sessions (10 min TTL)
  const { error: sessionsError } = await supabase
    .from("oauth_sessions")
    .delete()
    .lt("expires_at", now);

  if (sessionsError) {
    logger.error("Failed to clean up oauth_sessions", { error: sessionsError.message });
  }

  // Clean up expired auth codes (10 min TTL)
  const { error: codesError } = await supabase
    .from("auth_codes")
    .delete()
    .lt("expires_at", now);

  if (codesError) {
    logger.error("Failed to clean up auth_codes", { error: codesError.message });
  }

  // Clean up expired rate limits
  const { error: rateLimitsError } = await supabase
    .from("rate_limits")
    .delete()
    .lt("reset_time", now);

  if (rateLimitsError) {
    logger.error("Failed to clean up rate_limits", { error: rateLimitsError.message });
  }

  // Clean up expired MCP tokens (30 day TTL)
  const { error: tokensError } = await supabase
    .from("mcp_tokens")
    .delete()
    .lt("expires_at", now);

  if (tokensError) {
    logger.error("Failed to clean up mcp_tokens", { error: tokensError.message });
  }

  // Clean up expired tool analytics (90 day TTL)
  const { error: analyticsError } = await supabase
    .from("tool_analytics")
    .delete()
    .lt("expires_at", now);

  if (analyticsError) {
    logger.error("Failed to clean up tool_analytics", { error: analyticsError.message });
  }

  logger.info("Cleanup completed");
}

/**
 * Schedule periodic cleanup of expired records
 */
export function scheduleCleanup(): void {
  // Clean up short-lived records every 5 minutes
  setInterval(async () => {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    // Clean oauth_sessions, auth_codes, and rate_limits
    await supabase.from("oauth_sessions").delete().lt("expires_at", now);
    await supabase.from("auth_codes").delete().lt("expires_at", now);
    await supabase.from("rate_limits").delete().lt("reset_time", now);
  }, 5 * 60 * 1000); // 5 minutes

  // Clean up MCP tokens every hour
  setInterval(async () => {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    await supabase
      .from("mcp_tokens")
      .delete()
      .lt("expires_at", now);

    logger.info("Scheduled cleanup: removed expired mcp_tokens");
  }, 60 * 60 * 1000); // 1 hour

  // Clean up tool analytics once per day (90 day TTL)
  setInterval(async () => {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    await supabase
      .from("tool_analytics")
      .delete()
      .lt("expires_at", now);

    logger.info("Scheduled cleanup: removed expired tool_analytics");
  }, 24 * 60 * 60 * 1000); // 24 hours

  logger.info("Cleanup scheduler started");
}
