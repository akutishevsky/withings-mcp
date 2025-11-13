import { Hono } from "hono";
import { tokenStore } from "./token-store.js";

const WITHINGS_AUTH_URL = "https://account.withings.com/oauth2_user/authorize2";
const WITHINGS_TOKEN_URL = "https://wbsapi.withings.net/v2/oauth2";

interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function createAuthRouter(config: OAuthConfig) {
  const auth = new Hono();

  // Start OAuth flow - redirect to Withings
  auth.get("/authorize", (c) => {
    const state = crypto.randomUUID();

    // TODO: Store state for CSRF validation

    const authUrl = new URL(WITHINGS_AUTH_URL);
    authUrl.searchParams.append("response_type", "code");
    authUrl.searchParams.append("client_id", config.clientId);
    authUrl.searchParams.append("redirect_uri", config.redirectUri);
    authUrl.searchParams.append("scope", "user.metrics,user.activity");
    authUrl.searchParams.append("state", state);

    return c.redirect(authUrl.toString());
  });

  // OAuth callback from Withings
  auth.get("/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code) {
      return c.json({ error: "No authorization code received" }, 400);
    }

    // TODO: Validate state for CSRF protection

    try {
      // Exchange code for access token
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
          code: code,
          redirect_uri: config.redirectUri,
        }),
      });

      const tokenData = await tokenResponse.json();

      if (tokenData.status !== 0) {
        return c.json({ error: "Failed to exchange token", details: tokenData }, 400);
      }

      // Generate MCP token
      const mcpToken = crypto.randomUUID();

      // Store token mapping
      await tokenStore.storeTokens(mcpToken, {
        withingsAccessToken: tokenData.body.access_token,
        withingsRefreshToken: tokenData.body.refresh_token,
        withingsUserId: tokenData.body.userid,
        expiresAt: Date.now() + tokenData.body.expires_in * 1000,
      });

      return c.json({
        message: "Authorization successful",
        mcpToken: mcpToken,
        expiresIn: tokenData.body.expires_in,
      });
    } catch (error) {
      return c.json({ error: "Token exchange failed", details: String(error) }, 500);
    }
  });

  return auth;
}
