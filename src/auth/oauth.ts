import { Hono } from "hono";
import { tokenStore } from "./token-store.js";
import crypto from "node:crypto";
import { openKv } from "@deno/kv";
import { createLogger } from "../utils/logger.js";
import { rateLimit } from "../server/rate-limiter.js";

const logger = createLogger({ component: "oauth" });

const WITHINGS_AUTH_URL = "https://account.withings.com/oauth2_user/authorize2";
const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

interface OAuthSession {
  state: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  redirectUri: string;
  clientId?: string;
}

interface AuthCode {
  withingsCode: string;
  clientId?: string;
  redirectUri: string;
  codeChallenge?: string;
}

interface RegisteredClient {
  clientId: string;
  clientSecret?: string;
  redirectUris: string[];
}

class OAuthStore {
  private kv: Awaited<ReturnType<typeof openKv>> | null = null;

  async init() {
    this.kv = await openKv();
  }

  async storeSession(sessionId: string, session: OAuthSession): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.set(["oauth_sessions", sessionId], session, { expireIn: 600000 }); // 10 min
  }

  async getSession(sessionId: string): Promise<OAuthSession | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<OAuthSession>(["oauth_sessions", sessionId]);
    return result.value;
  }

  async deleteSession(sessionId: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["oauth_sessions", sessionId]);
  }

  async storeAuthCode(code: string, data: AuthCode): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.set(["auth_codes", code], data, { expireIn: 600000 }); // 10 min
  }

  async getAuthCode(code: string): Promise<AuthCode | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<AuthCode>(["auth_codes", code]);
    return result.value;
  }

  async deleteAuthCode(code: string): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.delete(["auth_codes", code]);
  }

  async registerClient(clientId: string, client: RegisteredClient): Promise<void> {
    if (!this.kv) throw new Error("KV not initialized");
    await this.kv.set(["clients", clientId], client);
  }

  async getClient(clientId: string): Promise<RegisteredClient | null> {
    if (!this.kv) throw new Error("KV not initialized");
    const result = await this.kv.get<RegisteredClient>(["clients", clientId]);
    return result.value;
  }
}

const oauthStore = new OAuthStore();

function base64URLEncode(str: Buffer): string {
  return str.toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function sha256(buffer: string): Buffer {
  return crypto.createHash('sha256').update(buffer).digest();
}

export async function initOAuthStore() {
  await oauthStore.init();
}

export function createOAuthRouter(config: OAuthConfig) {
  const oauth = new Hono();

  // Dynamic client registration (open for MCP compatibility, protected by rate limiting)
  oauth.post(
    "/register",
    rateLimit({ maxRequests: 30, windowMs: 3600000 }), // 30 requests per hour
    async (c) => {
      const body = await c.req.json();
      const clientId = crypto.randomUUID();

      await oauthStore.registerClient(clientId, {
        clientId,
        redirectUris: body.redirect_uris || [],
      });

      logger.info("OAuth client registered");

      return c.json({
        client_id: clientId,
        redirect_uris: body.redirect_uris || [],
      });
    }
  );

  // Authorization endpoint - MCP client starts here
  oauth.get(
    "/authorize",
    rateLimit({ maxRequests: 60, windowMs: 3600000 }), // 60 requests per hour
    async (c) => {
    const responseType = c.req.query("response_type");
    const clientId = c.req.query("client_id");
    const redirectUri = c.req.query("redirect_uri");
    const state = c.req.query("state");
    const codeChallenge = c.req.query("code_challenge");
    const codeChallengeMethod = c.req.query("code_challenge_method");

    if (responseType !== "code") {
      logger.warn("OAuth authorization failed: unsupported response type");
      return c.json({ error: "unsupported_response_type" }, 400);
    }

    if (!redirectUri) {
      logger.warn("OAuth authorization failed: missing redirect_uri");
      return c.json({ error: "invalid_request", error_description: "redirect_uri is required" }, 400);
    }

    // Require state parameter for CSRF protection
    if (!state) {
      logger.warn("OAuth authorization failed: missing state parameter");
      return c.json({ error: "invalid_request", error_description: "state parameter is required for CSRF protection" }, 400);
    }

    logger.info("Starting OAuth authorization flow");

    // Generate internal state for Withings OAuth
    const internalState = crypto.randomUUID();

    // Store OAuth session
    await oauthStore.storeSession(internalState, {
      state,
      codeChallenge,
      codeChallengeMethod,
      redirectUri,
      clientId,
    });

    // Redirect to Withings OAuth
    const withingsAuthUrl = new URL(WITHINGS_AUTH_URL);
    withingsAuthUrl.searchParams.append("response_type", "code");
    withingsAuthUrl.searchParams.append("client_id", config.clientId);
    withingsAuthUrl.searchParams.append("redirect_uri", config.redirectUri);
    withingsAuthUrl.searchParams.append("scope", "user.metrics,user.activity,user.sleepevents");
    withingsAuthUrl.searchParams.append("state", internalState);

    return c.redirect(withingsAuthUrl.toString());
    }
  );

  // Callback from Withings
  oauth.get("/callback", async (c) => {
    const code = c.req.query("code");
    const internalState = c.req.query("state");

    if (!code || !internalState) {
      logger.warn("OAuth callback failed: missing code or state");
      return c.json({ error: "invalid_request" }, 400);
    }

    const session = await oauthStore.getSession(internalState);
    if (!session) {
      logger.warn("OAuth callback failed: invalid or expired state");
      return c.json({ error: "invalid_state" }, 400);
    }

    logger.info("Processing OAuth callback from Withings");

    // Generate authorization code for MCP client
    const authCode = crypto.randomUUID();

    // Store auth code with Withings code
    await oauthStore.storeAuthCode(authCode, {
      withingsCode: code,
      clientId: session.clientId,
      redirectUri: session.redirectUri,
      codeChallenge: session.codeChallenge,
    });

    // Clean up session
    await oauthStore.deleteSession(internalState);

    // Redirect back to MCP client with state parameter (required for CSRF validation)
    const redirectUrl = new URL(session.redirectUri);
    redirectUrl.searchParams.append("code", authCode);
    redirectUrl.searchParams.append("state", session.state);

    return c.redirect(redirectUrl.toString());
  });

  // Token endpoint - MCP client exchanges code for token
  oauth.post(
    "/token",
    rateLimit({ maxRequests: 100, windowMs: 3600000 }), // 100 requests per hour
    async (c) => {
    const body = await c.req.parseBody();
    const grantType = body.grant_type;
    const code = body.code as string;
    const codeVerifier = body.code_verifier as string;

    if (grantType !== "authorization_code") {
      logger.warn("Token exchange failed: unsupported grant type");
      return c.json({ error: "unsupported_grant_type" }, 400);
    }

    const authCodeData = await oauthStore.getAuthCode(code);
    if (!authCodeData) {
      logger.warn("Token exchange failed: invalid authorization code");
      return c.json({ error: "invalid_grant" }, 400);
    }

    logger.info("Processing token exchange request");

    // Validate PKCE if code_challenge was provided
    if (authCodeData.codeChallenge) {
      if (!codeVerifier) {
        logger.warn("PKCE validation failed: missing code_verifier");
        return c.json({ error: "invalid_request", error_description: "code_verifier required" }, 400);
      }

      const hash = base64URLEncode(sha256(codeVerifier));
      if (hash !== authCodeData.codeChallenge) {
        logger.warn("PKCE validation failed: invalid code_verifier");
        return c.json({ error: "invalid_grant", error_description: "invalid code_verifier" }, 400);
      }
    }

    // Exchange Withings code for access token
    try {
      const tokenResponse = await fetch(WITHINGS_TOKEN_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          action: "requesttoken",
          grant_type: "authorization_code",
          client_id: config.clientId,
          client_secret: config.clientSecret,
          code: authCodeData.withingsCode,
          redirect_uri: config.redirectUri,
        }),
      });

      const tokenData = await tokenResponse.json();

      if (tokenData.status !== 0) {
        logger.error("Withings token exchange failed");
        return c.json({ error: "server_error", error_description: "Failed to exchange Withings token" }, 500);
      }

      // Generate MCP access token
      const mcpToken = crypto.randomUUID();

      // Store token mapping
      await tokenStore.storeTokens(mcpToken, {
        withingsAccessToken: tokenData.body.access_token,
        withingsRefreshToken: tokenData.body.refresh_token,
        withingsUserId: tokenData.body.userid,
        expiresAt: Date.now() + tokenData.body.expires_in * 1000,
      });

      // Clean up auth code
      await oauthStore.deleteAuthCode(code);

      logger.info("Token exchange completed successfully");

      return c.json({
        access_token: mcpToken,
        token_type: "Bearer",
        expires_in: tokenData.body.expires_in,
      });
    } catch (error) {
      logger.error("Token exchange error");
      return c.json({ error: "server_error", error_description: String(error) }, 500);
    }
    }
  );

  return oauth;
}

/**
 * Refresh Withings access token using refresh token
 */
export async function refreshWithingsToken(
  refreshToken: string,
  config: OAuthConfig
): Promise<{
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  userId: string;
}> {
  logger.info("Refreshing Withings access token");

  const tokenResponse = await fetch(WITHINGS_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      action: "requesttoken",
      grant_type: "refresh_token",
      client_id: config.clientId,
      client_secret: config.clientSecret,
      refresh_token: refreshToken,
    }),
  });

  const tokenData = await tokenResponse.json();

  if (tokenData.status !== 0) {
    logger.error("Withings token refresh failed");
    throw new Error(`Failed to refresh Withings token: ${tokenData.status}`);
  }

  logger.info("Token refresh completed successfully");

  return {
    accessToken: tokenData.body.access_token,
    refreshToken: tokenData.body.refresh_token,
    expiresIn: tokenData.body.expires_in,
    userId: tokenData.body.userid,
  };
}
