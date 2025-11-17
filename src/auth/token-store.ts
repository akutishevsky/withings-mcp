import { openKv } from "@deno/kv";
import { encrypt, decrypt } from "../utils/encryption.js";

export interface TokenData {
  withingsAccessToken: string;
  withingsRefreshToken: string;
  withingsUserId: string;
  expiresAt: number;
}

// Encrypted version stored in KV
interface EncryptedTokenData {
  encryptedAccessToken: string;
  encryptedRefreshToken: string;
  withingsUserId: string;
  expiresAt: number;
}

class TokenStore {
  private kv: Awaited<ReturnType<typeof openKv>> | null = null;

  async init() {
    this.kv = await openKv();
  }

  // Store MCP token -> Withings token mapping with encryption
  // TTL: 30 days - tokens expire after this period, requiring re-authentication
  async storeTokens(mcpToken: string, tokenData: TokenData): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

    // Encrypt sensitive tokens before storage
    const encryptedData: EncryptedTokenData = {
      encryptedAccessToken: encrypt(tokenData.withingsAccessToken),
      encryptedRefreshToken: encrypt(tokenData.withingsRefreshToken),
      withingsUserId: tokenData.withingsUserId,
      expiresAt: tokenData.expiresAt,
    };

    await this.kv.set(["tokens", mcpToken], encryptedData, { expireIn: TTL_MS });
  }

  // Get Withings tokens by MCP token and decrypt
  async getTokens(mcpToken: string): Promise<TokenData | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<EncryptedTokenData>(["tokens", mcpToken]);

    if (!result.value) {
      return null;
    }

    // Decrypt tokens before returning
    return {
      withingsAccessToken: decrypt(result.value.encryptedAccessToken),
      withingsRefreshToken: decrypt(result.value.encryptedRefreshToken),
      withingsUserId: result.value.withingsUserId,
      expiresAt: result.value.expiresAt,
    };
  }

  // Check if MCP token is valid
  // MCP token validity is determined by KV TTL (30 days)
  // The expiresAt field tracks Withings token expiration for refresh purposes only
  async isValid(mcpToken: string): Promise<boolean> {
    const data = await this.getTokens(mcpToken);
    return data !== null; // If entry exists in KV, MCP token is valid (KV TTL handles expiration)
  }

  // Update tokens after refresh (preserves the MCP token mapping and TTL, re-encrypts)
  async updateTokens(mcpToken: string, updates: Partial<TokenData>): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    const existing = await this.getTokens(mcpToken);
    if (!existing) throw new Error("Token not found");

    const updatedData: TokenData = {
      ...existing,
      ...updates,
    };

    // Re-encrypt with updated data
    const encryptedData: EncryptedTokenData = {
      encryptedAccessToken: encrypt(updatedData.withingsAccessToken),
      encryptedRefreshToken: encrypt(updatedData.withingsRefreshToken),
      withingsUserId: updatedData.withingsUserId,
      expiresAt: updatedData.expiresAt,
    };

    const TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
    await this.kv.set(["tokens", mcpToken], encryptedData, { expireIn: TTL_MS });
  }

  // Delete token
  async deleteToken(mcpToken: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["tokens", mcpToken]);
  }
}

export const tokenStore = new TokenStore();
