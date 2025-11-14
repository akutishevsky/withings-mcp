import type { OAuthConfig } from "./auth/oauth.js";

/**
 * Global OAuth configuration
 * This is initialized once at startup and shared across modules
 */
let oauthConfig: OAuthConfig | null = null;

export function setOAuthConfig(config: OAuthConfig): void {
  oauthConfig = config;
}

export function getOAuthConfig(): OAuthConfig {
  if (!oauthConfig) {
    throw new Error("OAuth config not initialized");
  }
  return oauthConfig;
}
