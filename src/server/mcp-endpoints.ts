import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { registerAllTools } from "../tools/index.js";
import { createLogger } from "../utils/logger.js";
import type { AppContext } from "../types/hono.js";

const logger = createLogger({ component: "mcp-endpoints" });

// Session tracking: sessionId -> { transport, mcpToken }
const sessions = new Map<string, {
  transport: WebStandardStreamableHTTPServerTransport;
  mcpToken: string;
}>();

/**
 * Unified handler for /mcp endpoint (GET, POST, DELETE).
 * Uses the SDK's WebStandardStreamableHTTPServerTransport which handles
 * all protocol details internally (SSE streaming, JSON-RPC validation,
 * session lifecycle).
 */
export const handleMcp = async (c: AppContext) => {
  const mcpToken = c.get("accessToken");
  const sessionId = c.req.header("mcp-session-id");

  const session = sessionId ? sessions.get(sessionId) : undefined;

  // Session ID provided but not found
  if (sessionId && !session) {
    return c.json({ error: "invalid_session" }, 404);
  }

  // Validate bearer token matches session owner
  if (session && session.mcpToken !== mcpToken) {
    logger.warn("Session access denied: token does not match session owner");
    return c.json({ error: "forbidden" }, 403);
  }

  // Existing session — forward to its transport.
  // `parsedBody` is populated by the JSON body parser middleware that
  // `createMcpHonoApp` installs on the app, so the transport reuses it
  // instead of re-parsing the request body.
  if (session) {
    return session.transport.handleRequest(c.req.raw, {
      parsedBody: c.get("parsedBody"),
    });
  }

  // No session — only POST can initialize
  if (c.req.method !== "POST") {
    return c.json({ error: "invalid_request" }, 400);
  }

  // New session — create transport + server
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { transport, mcpToken });
      logger.info("MCP session established");
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      logger.info("MCP session closed");
    },
  });

  const server = new McpServer(
    { name: "withings-mcp", version: "2.1.0" },
    { capabilities: { tools: {} } }
  );
  registerAllTools(server, mcpToken);
  await server.connect(transport);

  return transport.handleRequest(c.req.raw, {
    parsedBody: c.get("parsedBody"),
  });
};
