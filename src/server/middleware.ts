import { tokenStore } from "../auth/token-store.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "middleware" });

/**
 * Bearer token authentication middleware
 * Validates the MCP access token and stores it in the context
 */
export const authenticateBearer = async (c: any, next: any) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    logger.warn("Authentication failed: missing or invalid authorization header");
    return c.json({ error: "unauthorized", error_description: "Bearer token required" }, 401);
  }

  const token = authHeader.substring(7);
  const isValid = await tokenStore.isValid(token);
  if (!isValid) {
    logger.warn("Authentication failed: invalid or expired token");
    return c.json({ error: "invalid_token", error_description: "Token is invalid or expired" }, 401);
  }

  // Store token in context for later use
  c.set("accessToken" as any, token);
  await next();
};
