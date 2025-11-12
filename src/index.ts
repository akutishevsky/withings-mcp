#!/usr/bin/env node

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Hono } from "hono";
import { createAuthRouter } from "./auth.js";
import { tokenStore } from "./token-store.js";
import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";

// Initialize token store
await tokenStore.init();

const app = new Hono();

// OAuth configuration
const oauthConfig = {
  clientId: process.env.WITHINGS_CLIENT_ID || "",
  clientSecret: process.env.WITHINGS_CLIENT_SECRET || "",
  redirectUri: process.env.WITHINGS_REDIRECT_URI || "http://localhost:3000/auth/callback",
};

// Mount auth router
app.route("/auth", createAuthRouter(oauthConfig));

const server = new Server(
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

// List available tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [],
}));

// Handle tool calls
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name } = request.params;
  throw new Error(`Unknown tool: ${name}`);
});

// Health check endpoint
app.get("/health", (c) => {
  return c.json({ status: "ok" });
});

const port = parseInt(process.env.PORT || "3000");

// Create HTTP server
const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  // Handle SSE endpoint directly for MCP
  if (req.url === "/sse") {
    const transport = new SSEServerTransport("/message", res);
    await server.connect(transport);
    return;
  }

  // Let Hono handle all other routes
  const url = new URL(req.url || "/", `http://localhost:${port}`);
  const request = new Request(url, {
    method: req.method || "GET",
    headers: req.headers as HeadersInit,
  });
  const response = await app.fetch(request);

  // Copy response to Node.js response
  res.statusCode = response.status;
  response.headers.forEach((value, key) => {
    res.setHeader(key, value);
  });

  if (response.body) {
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(value);
    }
  }
  res.end();
});

httpServer.listen(port, () => {
  console.log(`Withings MCP Server running on http://localhost:${port}`);
});
