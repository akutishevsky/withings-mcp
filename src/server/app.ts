import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import { readFile } from "node:fs/promises";
import { createOAuthRouter } from "../auth/oauth.js";
import { authenticateBearer } from "./middleware.js";
import { handleMcp } from "./mcp-endpoints.js";
import { createLogger } from "../utils/logger.js";
import type { AppEnv } from "../types/hono.js";

const accessLogger = createLogger({ component: "access" });

export interface ServerConfig {
  oauthConfig: {
    clientId: string;
    clientSecret: string;
    redirectUri: string;
  };
}

const MCP_ENDPOINT = "/mcp";

/**
 * Resolve the externally-visible base URL for this request.
 * Honors x-forwarded-proto so URLs advertised to clients use https when the
 * server sits behind a TLS-terminating reverse proxy (Cloudflare, DO App Platform).
 */
// deno-lint-ignore no-explicit-any
function getPublicBaseUrl(c: any): string {
  const url = new URL(c.req.url);
  const forwardedProto = c.req.header("x-forwarded-proto");
  if (forwardedProto) {
    url.protocol = `${forwardedProto.split(",")[0].trim()}:`;
  }
  return url.origin;
}

export { getPublicBaseUrl };

/**
 * Create and configure the Hono application
 */
export function createApp(config: ServerConfig) {
  const app = new Hono<AppEnv>();

  // Access log — records every inbound request so we can see what a client is
  // (or isn't) hitting. Runs first so even 4xx/5xx / short-circuit responses
  // from later middleware are logged.
  app.use("*", async (c, next) => {
    const start = Date.now();
    const ua = c.req.header("user-agent") || "-";
    await next();
    const ms = Date.now() - start;
    accessLogger.info(`${c.req.method} ${c.req.path} -> ${c.res.status} ${ms}ms ua="${ua}"`);
  });

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

    // Content-Security-Policy: Restrict resource loading (skip if route already set one)
    if (!c.res.headers.get("Content-Security-Policy")) {
      c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
    }

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
      const allowedOrigins = Bun.env.ALLOWED_ORIGINS?.split(',').map(o => o.trim()) || [];
      if (allowedOrigins.includes(origin)) {
        return origin;
      }

      // Reject all other origins
      return null;
    },
    allowMethods: ["GET", "POST", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization", "Mcp-Session-Id", "Mcp-Protocol-Version", "Last-Event-ID", "Accept"],
    exposeHeaders: ["Mcp-Session-Id", "Mcp-Protocol-Version", "Content-Type"],
    credentials: false,
    maxAge: 86400,
  }));

  // Serve static CSS files
  app.get("/styles/:file", async (c) => {
    const fileName = c.req.param("file");
    // Only allow .css files, no path traversal
    if (!fileName.match(/^[a-z0-9-]+\.css$/)) {
      return c.notFound();
    }
    try {
      const css = await readFile(`./public/styles/${fileName}`, "utf-8");
      return c.body(css, 200, { "Content-Type": "text/css" });
    } catch {
      return c.notFound();
    }
  });

  // Serve static JS files
  app.get("/scripts/:file", async (c) => {
    const fileName = c.req.param("file");
    // Only allow .js files, no path traversal
    if (!fileName.match(/^[a-z0-9-]+\.js$/)) {
      return c.notFound();
    }
    try {
      const js = await readFile(`./public/scripts/${fileName}`, "utf-8");
      return c.body(js, 200, { "Content-Type": "application/javascript" });
    } catch {
      return c.notFound();
    }
  });

  // Root landing page
  app.get("/", async (c) => {
    try {
      const html = await readFile("./public/index.html", "utf-8");
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://storage.ko-fi.com; connect-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; img-src 'self' https://raw.githubusercontent.com https://www.google-analytics.com https://*.google-analytics.com https://*.googletagmanager.com https://storage.ko-fi.com https://ko-fi.com; frame-ancestors 'none'");
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

  // MCP endpoint — SDK transport handles GET, POST, DELETE internally
  app.all(MCP_ENDPOINT, authenticateBearer, handleMcp);

  // OAuth Authorization Server Metadata (RFC 8414)
  app.get("/.well-known/oauth-authorization-server", (c) => {
    const baseUrl = getPublicBaseUrl(c);
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

  // OAuth Protected Resource Metadata (RFC 9728) — tells MCP clients which
  // authorization server protects this resource. Required by the MCP 2025-06-18
  // auth spec so clients know to run OAuth discovery after a 401 from /mcp.
  app.get("/.well-known/oauth-protected-resource", (c) => {
    const baseUrl = getPublicBaseUrl(c);
    return c.json({
      resource: baseUrl,
      authorization_servers: [baseUrl],
      bearer_methods_supported: ["header"],
      scopes_supported: [],
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
      c.header("Content-Security-Policy", "default-src 'none'; style-src 'self'; script-src 'self' https://www.googletagmanager.com; connect-src https://www.google-analytics.com https://*.google-analytics.com https://*.analytics.google.com https://www.googletagmanager.com; img-src 'self' https://www.google-analytics.com https://*.google-analytics.com https://*.googletagmanager.com; frame-ancestors 'none'");
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
