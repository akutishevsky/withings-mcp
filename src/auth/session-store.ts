import { getSupabaseClient } from "../db/supabase.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "session-store" });

export interface SessionData {
  sessionId: string;
  mcpToken: string;
}

interface McpSessionRow {
  session_id: string;
  mcp_token: string;
  last_activity_at: string;
  expires_at: string;
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

class SessionStore {
  async init(): Promise<void> {
    // No initialization needed - Supabase client is initialized separately
  }

  // Record an established MCP session so it can be rebuilt after a restart
  // (or served by another instance). Only the token binding is stored — the
  // transport and McpServer are reconstructed on demand.
  async create(sessionId: string, mcpToken: string): Promise<void> {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    const { error } = await supabase.from("mcp_sessions").upsert({
      session_id: sessionId,
      mcp_token: mcpToken,
      last_activity_at: now,
      expires_at: new Date(Date.now() + TTL_MS).toISOString(),
      updated_at: now,
    }, {
      onConflict: "session_id",
    });

    if (error) {
      throw new Error(`Failed to store MCP session: ${error.message}`);
    }
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("mcp_sessions")
      .select("*")
      .eq("session_id", sessionId)
      .gt("expires_at", now)
      .single();

    if (error || !data) {
      return null;
    }

    const row = data as McpSessionRow;

    return {
      sessionId: row.session_id,
      mcpToken: row.mcp_token,
    };
  }

  // Extend a session's lifetime. Called on a throttle (not per request), and
  // deliberately fire-and-forget: a failed heartbeat must never break a tool
  // call, it only risks the session expiring earlier than it should.
  async touch(sessionId: string): Promise<void> {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    const { error } = await supabase
      .from("mcp_sessions")
      .update({
        last_activity_at: now,
        expires_at: new Date(Date.now() + TTL_MS).toISOString(),
        updated_at: now,
      })
      .eq("session_id", sessionId);

    if (error) {
      logger.warn("Failed to refresh MCP session activity", {
        error: error.message,
      });
    }
  }

  async delete(sessionId: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("mcp_sessions")
      .delete()
      .eq("session_id", sessionId);

    if (error) {
      throw new Error(`Failed to delete MCP session: ${error.message}`);
    }
  }

  // Follow an MCP token rotation (OAuth refresh_token grant) so sessions
  // established under the old bearer stay owned by the same client instead of
  // being rejected as belonging to someone else.
  async rotateToken(oldToken: string, newToken: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("mcp_sessions")
      .update({
        mcp_token: newToken,
        updated_at: new Date().toISOString(),
      })
      .eq("mcp_token", oldToken);

    if (error) {
      throw new Error(`Failed to rotate MCP session token: ${error.message}`);
    }
  }
}

export const sessionStore = new SessionStore();
