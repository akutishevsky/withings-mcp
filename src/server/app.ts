import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { createOAuthRouter } from "../auth/oauth.js";
import { authenticateBearer } from "./middleware.js";
import { handleMcpGet, handleMcpPost } from "./mcp-endpoints.js";

export interface ServerConfig {
  oauthConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
}

const MCP_ENDPOINT = "/mcp";

/**
 * Create and configure the Hono application
 */
export function createApp(config: ServerConfig) {
  const app = new Hono();

  // HTTPS redirect in production (behind reverse proxy)
  app.use("*", async (c, next) => {
    const proto = c.req.header("x-forwarded-proto");
    const host = c.req.header("host") || "";
    const isLocalhost = host.startsWith("localhost") || host.startsWith("127.0.0.1");

    if (proto === "http" && !isLocalhost) {
      const httpsUrl = `https://${host}${c.req.path}`;
      return c.redirect(httpsUrl, 301);
    }

    await next();
  });

  // Security headers middleware
  app.use("*", async (c, next) => {
    await next();

    // Strict-Transport-Security: Force HTTPS in production
    if (c.req.url.startsWith("https://")) {
      c.header("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }

    // X-Content-Type-Options: Prevent MIME sniffing
    c.header("X-Content-Type-Options", "nosniff");

    // X-Frame-Options: Prevent clickjacking
    c.header("X-Frame-Options", "DENY");

    // Content-Security-Policy: Restrict resource loading
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");

    // Referrer-Policy: Control referrer information
    c.header("Referrer-Policy", "no-referrer");

    // Permissions-Policy: Disable unnecessary browser features
    c.header("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  });

  // Request body size limit (1MB) to prevent memory exhaustion
  app.use("*", bodyLimit({
    maxSize: 1024 * 1024, // 1MB
    onError: (c) => {
      return c.json({
        error: "payload_too_large",
        error_description: "Request body exceeds maximum allowed size"
      }, 413);
    },
  }));

  // Enable CORS with security restrictions
  // Allow native apps (no Origin header), localhost, and configured origins
  app.use("*", cors({
    origin: (origin) => {
      // No Origin header = native app or server-side request (not browser).
      // CORS doesn't apply, so skip adding CORS headers entirely.
      if (!origin) {
        return null;
      }

      // Allow localhost for development
      if (origin.match(/^https?:\/\/localhost(:\d+)?$/) ||
          origin.match(/^https?:\/\/127\.0\.0\.1(:\d+)?$/)) {
        return origin;
      }

      // Allow configured origins (comma-separated list in env var)
      const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
      if (allowedOrigins.includes(origin)) {
        return origin;
      }

      // Reject all other origins
      return null;
    },
    allowMethods: ["GET", "POST", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Accept"],
    exposeHeaders: ["Mcp-Session-Id", "Content-Type"],
    credentials: false,
    maxAge: 86400,
  }));

  // Root landing page
  app.get("/", async (c) => {
    try {
      const html = await readFile("./public/index.html", "utf-8");
      // Override CSP to allow inline styles for this landing page
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      return c.html(html);
    } catch {
      return c.notFound();
    }
  });

  // Mount OAuth router at root level (per spec)
  app.route("/", createOAuthRouter(config.oauthConfig));

  // Backwards compatibility redirect for old callback URL
  app.get("/auth/callback", (c) => {
    const url = new URL(c.req.url);
    url.pathname = "/callback";
    return c.redirect(url.toString());
  });

  // MCP endpoints - GET and POST
  app.get(MCP_ENDPOINT, authenticateBearer, handleMcpGet);
  app.post(MCP_ENDPOINT, authenticateBearer, handleMcpPost);

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
      mcp_endpoint: `${baseUrl}${MCP_ENDPOINT}`,
    });
  });

  // Favicon endpoint
  app.get("/favicon.ico", async (c) => {
    try {
      const file = await readFile("./public/favicon.ico");
      return c.body(file, 200, { "Content-Type": "image/x-icon" });
    } catch {
      return c.notFound();
    }
  });

  // Health check endpoint
  app.get("/health", async (c) => {
    try {
      const html = await readFile("./public/health.html", "utf-8");
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'");
      return c.html(html);
    } catch {
      return c.notFound();
    }
  });

  // Error handler - sanitize error messages to avoid leaking internal details
  app.onError((err, c) => {
    // Log full error server-side for debugging
    console.error("Unhandled error:", err);

    // Return sanitized error to client
    return c.json({
      error: "internal_server_error",
      error_description: "An internal server error occurred. Please try again later."
    }, 500);
  });

  return app;
}
