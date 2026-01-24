import { getSupabaseClient } from "../db/supabase.js";
import { encrypt, decrypt } from "../utils/encryption.js";

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
}

export const tokenStore = new TokenStore();
