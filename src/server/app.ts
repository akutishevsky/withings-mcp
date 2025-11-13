import { Hono } from "hono";
import { createOAuthRouter } from "../auth/oauth.js";
import { authenticateBearer } from "./middleware.js";
import { handleMcpGet, handleMcpPost } from "./mcp-endpoints.js";

export interface ServerConfig {
  oauthConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
  mcpEndpoint?: string;
}

/**
 * Create and configure the Hono application
 */
export function createApp(config: ServerConfig) {
  const app = new Hono();
  const mcpEndpoint = config.mcpEndpoint || "/mcp";

  // Mount OAuth router at root level (per spec)
  app.route("/", createOAuthRouter(config.oauthConfig));

  // Backwards compatibility redirect for old callback URL
  app.get("/auth/callback", (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    const url = new URL(c.req.url);
    url.pathname = "/callback";
    return c.redirect(url.toString());
  });

  // MCP endpoints - GET and POST
  app.get(mcpEndpoint, authenticateBearer, handleMcpGet);
  app.post(mcpEndpoint, authenticateBearer, handleMcpPost);

  // OAuth metadata discovery endpoint
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const baseUrl = new URL(c.req.url).origin;
    return c.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      grant_types_supported: ["authorization_code", "refresh_token"],
      response_types_supported: ["code"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      // MCP-specific metadata
      mcp_endpoint: `${baseUrl}${mcpEndpoint}`,
    });
  });

  // Health check endpoint
  app.get("/health", (c) => {
    return c.json({ status: "ok" });
  });

  return app;
}
