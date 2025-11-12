import { openKv } from "@deno/kv";

interface TokenData {
  withingsAccessToken: string;
  withingsRefreshToken: string;
  withingsUserId: string;
  expiresAt: number;
}

class TokenStore {
  private kv: Awaited<ReturnType<typeof openKv>> | null = null;

  async init() {
    this.kv = await openKv();
  }

  // Store MCP token -> Withings token mapping
  async storeTokens(mcpToken: string, tokenData: TokenData): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.set(["tokens", mcpToken], tokenData);
  }

  // Get Withings tokens by MCP token
  async getTokens(mcpToken: string): Promise<TokenData | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<TokenData>(["tokens", mcpToken]);
    return result.value;
  }

  // Check if MCP token is valid
  async isValid(mcpToken: string): Promise<boolean> {
    const data = await this.getTokens(mcpToken);
    if (!data) return false;
    return Date.now() < data.expiresAt;
  }

  // Delete token
  async deleteToken(mcpToken: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["tokens", mcpToken]);
  }
}

export const tokenStore = new TokenStore();
