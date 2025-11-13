import { tokenStore } from "../auth/token-store.js";

/**
 * Bearer token authentication middleware
 * Validates the MCP access token and stores it in the context
 */
export const authenticateBearer = async (c: any, next: any) => {
  const authHeader = c.req.header("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    console.error("MCP request missing Bearer token");
    return c.json({ error: "unauthorized", error_description: "Bearer token required" }, 401);
  }

  const token = authHeader.substring(7);
  const isValid = await tokenStore.isValid(token);
  if (!isValid) {
    console.error("MCP request with invalid token");
    return c.json({ error: "invalid_token", error_description: "Token is invalid or expired" }, 401);
  }

  console.log("MCP request authenticated successfully");

  // Store token in context for later use
  c.set("accessToken" as any, token);
  await next();
};
