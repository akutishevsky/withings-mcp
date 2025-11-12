#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Hono } from "hono";
import { createOAuthRouter, initOAuthStore } from "./oauth.js";
import { tokenStore } from "./token-store.js";
import { streamSSE } from "hono/streaming";
import { HonoSSETransport, sessionManager } from "./mcp-transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { getUserDevices } from "./withings-api.js";

// Initialize stores
await tokenStore.init();
await initOAuthStore();

const app = new Hono();

// OAuth configuration
const oauthConfig = {
  clientId: process.env.WITHINGS_CLIENT_ID || "",
  clientSecret: process.env.WITHINGS_CLIENT_SECRET || "",
  redirectUri: process.env.WITHINGS_REDIRECT_URI || "http://localhost:3000/callback",
};

// Mount OAuth router at root level (per spec)
app.route("/", createOAuthRouter(oauthConfig));

// Backwards compatibility redirect for old callback URL
app.get("/auth/callback", (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const url = new URL(c.req.url);
  url.pathname = "/callback";
  return c.redirect(url.toString());
});

const mcpServer = new McpServer(
  {
    name: "withings-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// TODO: Register tools here when ready
// Example: mcpServer.registerTool("tool_name", { description: "..." }, async (args) => { ... });

// MCP endpoint - handles both GET (SSE) and POST (JSON-RPC messages)
const mcpEndpoint = "/mcp";

// Bearer token authentication middleware
const authenticateBearer = async (c: any, next: any) => {
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

// GET - Initiate SSE stream for MCP
app.get(mcpEndpoint, authenticateBearer, async (c) => {
  // Get or create session ID
  const sessionId = c.req.header("Mcp-Session-Id") || crypto.randomUUID();

  console.log("SSE connection request for session:", sessionId);

  // Get the MCP access token from context
  const mcpAccessToken = (c as any).get("accessToken") as string;

  // Check for existing session
  const existingSession = sessionManager.getSession(sessionId);
  if (existingSession) {
    console.log("Closing existing session");
    // Close existing transport if any
    await existingSession.transport.close();
    sessionManager.deleteSession(sessionId);
  }

  // Set headers BEFORE starting stream
  c.header("Mcp-Session-Id", sessionId);
  c.header("Cache-Control", "no-cache");
  c.header("X-Accel-Buffering", "no"); // Disable nginx buffering

  return streamSSE(c, async (stream) => {
    console.log("Starting SSE stream for session:", sessionId);

    // Create transport
    const transport = new HonoSSETransport();
    transport.attachStream(stream);

    console.log("Transport created and stream attached");

    // Create new MCP server instance for this session
    const sessionServer = new McpServer(
      {
        name: "withings-mcp",
        version: "1.0.0",
      },
      {
        capabilities: {
          tools: {},
        },
      }
    );

    // Register Withings tools
    console.log("Registering Withings tools...");
    sessionServer.registerTool(
      "get_user_devices",
      {
        description: "Get list of user's Withings devices including device type, model, battery level, and last sync time",
        inputSchema: {},
      },
      async () => {
        console.log("get_user_devices tool called");
        try {
          const devices = await getUserDevices(mcpAccessToken);
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(devices, null, 2),
              },
            ],
          };
        } catch (error) {
          console.error("Error fetching devices:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: ${error instanceof Error ? error.message : String(error)}`,
              },
            ],
            isError: true,
          };
        }
      }
    );

    console.log("Tools registered successfully");

    try {
      // Connect server to transport
      console.log("Connecting MCP server to transport...");
      await sessionServer.connect(transport);
      console.log("MCP server connected successfully");

      // Store session
      sessionManager.createSession(sessionId, transport);
      console.log("Session stored in session manager");

      // Handle connection close
      c.req.raw.signal.addEventListener("abort", () => {
        sessionManager.deleteSession(sessionId);
      });

      // Keep connection alive - send heartbeat
      const heartbeat = setInterval(async () => {
        try {
          await stream.writeSSE({
            data: "",
            event: "ping",
          });
        } catch (error) {
          clearInterval(heartbeat);
        }
      }, 15000);

      // Cleanup on abort
      c.req.raw.signal.addEventListener("abort", () => {
        clearInterval(heartbeat);
      });

    } catch (error) {
      console.error("Failed to establish MCP connection:", error);
      sessionManager.deleteSession(sessionId);
      throw error;
    }
  });
});

// POST - Receive JSON-RPC messages from client
app.post(mcpEndpoint, authenticateBearer, async (c) => {
  const sessionId = c.req.header("Mcp-Session-Id");

  console.log("POST message received for session:", sessionId);

  if (!sessionId) {
    console.error("POST request missing session ID");
    return c.json({
      error: "invalid_request",
      error_description: "Mcp-Session-Id header required"
    }, 400);
  }

  const session = sessionManager.getSession(sessionId);
  if (!session) {
    console.error("Session not found:", sessionId);
    return c.json({
      error: "invalid_session",
      error_description: "Session not found or expired"
    }, 404);
  }

  try {
    const message = await c.req.json() as JSONRPCMessage;
    console.log("Received JSON-RPC message:", { method: (message as any).method, id: (message as any).id });

    // Forward message to transport
    await session.transport.handleIncomingMessage(message);

    // Return 202 Accepted (response will come via SSE)
    return c.body(null, 202);
  } catch (error) {
    console.error("Error handling MCP message:", error);
    return c.json({
      error: "internal_error",
      error_description: "Failed to process message"
    }, 500);
  }
});

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

// Export for Deno Deploy
export default {
  fetch: app.fetch,
};
