import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { registerAllTools } from "../tools/index.js";
import { createLogger } from "../utils/logger.js";

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
 * session lifecycle, heartbeats).
 */
export const handleMcp = async (c: any) => {
  const mcpToken = c.get("accessToken") as string;
  const sessionId = c.req.header("mcp-session-id");

  // Look up existing session
  const session = sessionId ? sessions.get(sessionId) : undefined;

  // Session ID provided but not found
  if (sessionId && !session) {
    return c.json({
      error: "invalid_session",
      error_description: "Session not found or expired"
    }, 404);
  }

  // Validate bearer token matches session owner
  if (session && session.mcpToken !== mcpToken) {
    logger.warn("Session access denied: token does not match session owner");
    return c.json({
      error: "forbidden",
      error_description: "Token does not match session owner"
    }, 403);
  }

  // Existing session — forward to its transport
  if (session) {
    return session.transport.handleRequest(c.req.raw);
  }

  // No session — only POST can initialize
  if (c.req.method !== "POST") {
    return c.json({
      error: "invalid_request",
      error_description: "No session. Send an initialization POST to create one."
    }, 400);
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
    { name: "withings-mcp", version: "1.3.0" },
    { capabilities: { tools: {} } }
  );
  registerAllTools(server, mcpToken);
  await server.connect(transport);

  return transport.handleRequest(c.req.raw);
};
