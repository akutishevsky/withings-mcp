import { getSupabaseClient } from "../db/supabase.js";
import { encrypt, decrypt } from "../utils/encryption.js";
import { sessionStore } from "./session-store.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "token-store" });

export interface TokenData {
  withingsAccessToken: string;
  withingsRefreshToken: string;
  withingsUserId: string;
  expiresAt: number;
}

interface McpTokenRow {
  mcp_token: string;
  encrypted_access_token: string;
  encrypted_refresh_token: string;
  withings_user_id: string;
  withings_expires_at: number;
  expires_at: string;
}

const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

// After a rotation the superseded token stays resolvable for this long, so a
// retried or concurrent refresh is handed the same token the winning request
// got instead of being told its grant is dead. Long enough to cover a client's
// immediate retry, short enough that a rotated token is not usable in practice.
const ROTATION_GRACE_MS = 60 * 1000; // 60 seconds

class TokenStore {
  async init(): Promise<void> {
    // No initialization needed - Supabase client is initialized separately
  }

  // Store MCP token -> Withings token mapping with encryption
  // TTL: 30 days - tokens expire after this period, requiring re-authentication
  async storeTokens(mcpToken: string, tokenData: TokenData): Promise<void> {
    const supabase = getSupabaseClient();
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

    // Encrypt sensitive tokens before storage
    const { error } = await supabase.from("mcp_tokens").upsert({
      mcp_token: mcpToken,
      encrypted_access_token: encrypt(tokenData.withingsAccessToken),
      encrypted_refresh_token: encrypt(tokenData.withingsRefreshToken),
      withings_user_id: tokenData.withingsUserId,
      withings_expires_at: tokenData.expiresAt,
      expires_at: expiresAt,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: "mcp_token",
    });

    if (error) {
      throw new Error(`Failed to store tokens: ${error.message}`);
    }
  }

  // Get Withings tokens by MCP token and decrypt
  async getTokens(mcpToken: string): Promise<TokenData | null> {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    const { data, error } = await supabase
      .from("mcp_tokens")
      .select("*")
      .eq("mcp_token", mcpToken)
      .gt("expires_at", now)
      .single();

    if (error || !data) {
      return null;
    }

    const row = data as McpTokenRow;

    // Decrypt tokens before returning
    return {
      withingsAccessToken: decrypt(row.encrypted_access_token),
      withingsRefreshToken: decrypt(row.encrypted_refresh_token),
      withingsUserId: row.withings_user_id,
      expiresAt: row.withings_expires_at,
    };
  }

  // Check if MCP token is valid
  // MCP token validity is determined by expires_at column (30 days TTL)
  // The expiresAt field tracks Withings token expiration for refresh purposes only
  async isValid(mcpToken: string): Promise<boolean> {
    const data = await this.getTokens(mcpToken);
    return data !== null;
  }

  // Update tokens after refresh (preserves the MCP token mapping and TTL, re-encrypts)
  async updateTokens(mcpToken: string, updates: Partial<TokenData>): Promise<void> {
    const supabase = getSupabaseClient();
    const existing = await this.getTokens(mcpToken);
    if (!existing) throw new Error("Token not found");

    const updatedData: TokenData = {
      ...existing,
      ...updates,
    };

    // Re-encrypt with updated data
    const { error } = await supabase
      .from("mcp_tokens")
      .update({
        encrypted_access_token: encrypt(updatedData.withingsAccessToken),
        encrypted_refresh_token: encrypt(updatedData.withingsRefreshToken),
        withings_user_id: updatedData.withingsUserId,
        withings_expires_at: updatedData.expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("mcp_token", mcpToken);

    if (error) {
      throw new Error(`Failed to update tokens: ${error.message}`);
    }
  }

  // Delete token
  async deleteToken(mcpToken: string): Promise<void> {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from("mcp_tokens")
      .delete()
      .eq("mcp_token", mcpToken);

    if (error) {
      throw new Error(`Failed to delete token: ${error.message}`);
    }
  }

  // Resolve a token presented to the refresh_token grant.
  //
  // Returns the token value that is currently live for that row. `isReplay`
  // means the caller presented a token that has already been rotated away but
  // is still inside the grace window — a retried or concurrent refresh — and
  // must be handed the existing token rather than triggering a second
  // rotation, which would strand whichever client stored the first response.
  async resolveRefreshToken(
    presentedToken: string
  ): Promise<{ currentToken: string; isReplay: boolean } | null> {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();

    const { data: live } = await supabase
      .from("mcp_tokens")
      .select("mcp_token")
      .eq("mcp_token", presentedToken)
      .gt("expires_at", now)
      .single();

    if (live) {
      return {
        currentToken: (live as { mcp_token: string }).mcp_token,
        isReplay: false,
      };
    }

    const { data: superseded } = await supabase
      .from("mcp_tokens")
      .select("mcp_token")
      .eq("previous_mcp_token", presentedToken)
      .gt("previous_token_expires_at", now)
      .gt("expires_at", now)
      .single();

    if (superseded) {
      return {
        currentToken: (superseded as { mcp_token: string }).mcp_token,
        isReplay: true,
      };
    }

    return null;
  }

  // Rotate the MCP token (for OAuth refresh_token grant). Keeps all stored
  // Withings credentials and user mapping intact, just swaps the public-facing
  // token value and extends the TTL.
  //
  // Returns false if no row still carried `oldToken` — i.e. a concurrent
  // request won the rotation race. The caller must not hand `newToken` to the
  // client in that case: it was never written, so it would authenticate
  // nothing. Use resolveRefreshToken() to recover the winner's value.
  async rotateToken(oldToken: string, newToken: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();

    const { data, error } = await supabase
      .from("mcp_tokens")
      .update({
        mcp_token: newToken,
        previous_mcp_token: oldToken,
        previous_token_expires_at: new Date(
          Date.now() + ROTATION_GRACE_MS
        ).toISOString(),
        expires_at: expiresAt,
        updated_at: new Date().toISOString(),
      })
      .eq("mcp_token", oldToken)
      .select("mcp_token");

    if (error) {
      throw new Error(`Failed to rotate token: ${error.message}`);
    }

    if (!data || data.length === 0) {
      return false;
    }

    // Sessions are owned by a token value, so they have to follow the
    // rotation — otherwise every session opened under the old bearer is
    // rejected as belonging to a different client.
    //
    // Deliberately non-fatal: mcp_tokens has already been committed above, so
    // throwing here would 500 the /token response while the client still holds
    // a token that no longer exists — locking the user out until they redo the
    // whole Withings OAuth flow. A stale session binding is far cheaper: it
    // costs one 403 and a client reconnect.
    try {
      await sessionStore.rotateToken(oldToken, newToken);
    } catch (err) {
      logger.warn("Failed to rotate MCP session ownership after token rotation", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return true;
  }
}

export const tokenStore = new TokenStore();
