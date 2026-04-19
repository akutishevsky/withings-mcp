import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
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
 * SSE keep-alive ping interval. Empty SSE comment lines every 15s prevent
 * Cloudflare (which fronts DO App Platform) and strict clients from closing
 * idle streams. 15s is well under Cloudflare's 100s HTTP/2 stream idle limit
 * and under most client read timeouts.
 */
const SSE_KEEPALIVE_MS = 15_000;

/**
 * Wrap the SDK transport's Response for SSE streams:
 *  - Tell Cloudflare / any nginx-style proxy NOT to buffer the stream
 *    (X-Accel-Buffering: no). Without this, proxies may hold the stream
 *    until enough bytes accumulate, causing clients to time out waiting.
 *  - Inject SSE keep-alive comments every 15s so the connection stays
 *    observably alive end-to-end.
 *
 * Non-SSE responses pass through unchanged.
 */
function prepareSseResponse(res: Response): Response {
  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("text/event-stream") || !res.body) {
    return res;
  }

  // Clone headers and disable edge buffering.
  const headers = new Headers(res.headers);
  headers.set("X-Accel-Buffering", "no");

  // Inject keep-alive comments alongside the transport's own writes.
  const encoder = new TextEncoder();
  const keepAlive = encoder.encode(":keep-alive\n\n");
  const upstream = res.body;

  const merged = new ReadableStream<Uint8Array>({
    start(controller) {
      const reader = upstream.getReader();
      let closed = false;

      const interval = setInterval(() => {
        if (closed) return;
        try {
          controller.enqueue(keepAlive);
        } catch {
          clearInterval(interval);
        }
      }, SSE_KEEPALIVE_MS);

      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            controller.enqueue(value);
          }
        } catch (err) {
          logger.warn("SSE upstream read failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        } finally {
          closed = true;
          clearInterval(interval);
          try {
            controller.close();
          } catch {
            // controller already closed
          }
        }
      };

      pump();
    },
    cancel(reason) {
      logger.debug("SSE stream cancelled by client", {
        reason: reason instanceof Error ? reason.message : String(reason ?? "unknown"),
      });
    },
  });

  return new Response(merged, {
    status: res.status,
    statusText: res.statusText,
    headers,
  });
}

/**
 * Unified handler for /mcp endpoint (GET, POST, DELETE).
 * Uses the SDK's WebStandardStreamableHTTPServerTransport which handles
 * all protocol details internally (SSE streaming, JSON-RPC validation,
 * session lifecycle, heartbeats).
 */
export const handleMcp = async (c: AppContext) => {
  const mcpToken = c.get("accessToken");
  const sessionId = c.req.header("mcp-session-id");

  // Look up existing session
  const session = sessionId ? sessions.get(sessionId) : undefined;

  logger.debug("MCP request", {
    method: c.req.method,
    hasSessionIdHeader: Boolean(sessionId),
    sessionFound: Boolean(session),
    activeSessions: sessions.size,
  });

  // Session ID provided but not found
  if (sessionId && !session) {
    logger.warn("MCP session lookup miss", {
      method: c.req.method,
      activeSessions: sessions.size,
    });
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
    return prepareSseResponse(await session.transport.handleRequest(c.req.raw));
  }

  // No session — only POST can initialize.
  //
  // Per MCP Streamable HTTP spec, GET/DELETE without a session must return
  // 405 Method Not Allowed (not 400). Some clients treat 4xx_non_405 as a
  // permanent server error and abandon the connection, whereas 405 signals
  // "try a different method" and nudges them to re-initialize via POST.
  if (c.req.method !== "POST") {
    logger.warn("MCP non-POST without session", {
      method: c.req.method,
      hasSessionIdHeader: Boolean(sessionId),
    });
    c.header("Allow", "POST");
    return c.json({
      error: "method_not_allowed",
      error_description: "No active session. Send an initialization POST first."
    }, 405);
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
    { name: "withings-mcp", version: "2.0.0" },
    { capabilities: { tools: {} } }
  );
  registerAllTools(server, mcpToken);
  await server.connect(transport);

  return prepareSseResponse(await transport.handleRequest(c.req.raw));
};
