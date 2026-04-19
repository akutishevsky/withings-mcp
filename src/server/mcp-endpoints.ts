import {
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { registerAllTools } from "../tools/index.js";
import { createLogger } from "../utils/logger.js";
import type { AppContext } from "../types/hono.js";

const logger = createLogger({ component: "mcp-endpoints" });

// Idle sessions are evicted after this many ms without any HTTP activity.
// Clients (Claude Desktop, web, mobile) usually drop the SSE stream without
// sending DELETE, so without this sweep the session Map grows unbounded.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  mcpToken: string;
  lastActivityAt: number;
}

const sessions = new Map<string, Session>();

const sweep = setInterval(() => {
  const cutoff = Date.now() - IDLE_TIMEOUT_MS;
  for (const [id, session] of sessions) {
    if (session.lastActivityAt < cutoff) {
      sessions.delete(id);
      session.transport.close().catch((err) => {
        logger.warn("Error closing idle transport", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      logger.info("Evicted idle MCP session");
    }
  }
}, SWEEP_INTERVAL_MS);
sweep.unref?.();

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
    session.lastActivityAt = Date.now();
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
      sessions.set(id, {
        transport,
        mcpToken,
        lastActivityAt: Date.now(),
      });
      logger.info("MCP session established");
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      logger.info("MCP session closed");
    },
  });

  // Belt-and-suspenders: onsessionclosed only fires on explicit DELETE.
  // onclose fires whenever the transport itself is torn down (idle sweep,
  // server shutdown, internal SDK errors), so wire both.
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

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
