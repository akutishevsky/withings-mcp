import { tokenStore } from "../auth/token-store.js";
import { createLogger } from "../utils/logger.js";
import { getPublicBaseUrl } from "./app.js";
import type { AppContext, AppNext } from "../types/hono.js";

const logger = createLogger({ component: "middleware" });

/**
 * Build the WWW-Authenticate header pointing MCP clients at the Protected
 * Resource Metadata document (RFC 9728). Without this, clients receive a bare
 * 401 and have no way to discover the authorization server.
 *
 * Format matches what working MCP clients (Claude Desktop, VSCode) actually
 * parse: a single `resource_metadata` parameter, no realm prefix.
 */
function buildWwwAuthenticate(c: AppContext): string {
  const resourceMetadata = `${getPublicBaseUrl(c)}/.well-known/oauth-protected-resource`;
  return `Bearer resource_metadata="${resourceMetadata}"`;
}

/**
 * Bearer token authentication middleware
 * Validates the MCP access token and stores it in the context
 */
export const authenticateBearer = async (c: AppContext, next: AppNext) => {
  const authHeader = c.req.header("Authorization");
  const path = c.req.path;
  const method = c.req.method;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn(`Authentication failed on ${method} ${path}: missing or invalid authorization header`);
    c.header("WWW-Authenticate", buildWwwAuthenticate(c));
    return c.json({ error: "unauthorized", error_description: "Bearer token required" }, 401);
  }

  const token = authHeader.substring(7);
  const isValid = await tokenStore.isValid(token);
  if (!isValid) {
    logger.warn(`Authentication failed on ${method} ${path}: invalid or expired token`);
    c.header("WWW-Authenticate", buildWwwAuthenticate(c));
    return c.json({ error: "invalid_token", error_description: "Token is invalid or expired" }, 401);
  }

  logger.info(`Authenticated request: ${method} ${path}`);
  // Store token in context for later use
  c.set("accessToken", token);
  await next();
};
