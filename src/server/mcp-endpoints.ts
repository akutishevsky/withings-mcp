import {
  isInitializeRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { sessionStore } from "../auth/session-store.js";
import { registerAllTools } from "../tools/index.js";
import { createLogger } from "../utils/logger.js";
import type { AppContext } from "../types/hono.js";

const logger = createLogger({ component: "mcp-endpoints" });

// Idle sessions are evicted from memory after this many ms without any HTTP
// activity. Clients (Claude Desktop, web, mobile) usually drop the SSE stream
// without sending DELETE, so without this sweep the session Map grows
// unbounded. Eviction is now only a memory optimisation — the Supabase row
// survives, so a returning client is transparently rehydrated.
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;

// Sessions are kept alive in Supabase by refreshing `expires_at`, but doing
// that on every request would add a write to each tool call. Throttle it.
const ACTIVITY_PERSIST_INTERVAL_MS = 5 * 60 * 1000;

interface Session {
  transport: WebStandardStreamableHTTPServerTransport;
  mcpToken: string;
  lastActivityAt: number;
  lastPersistedAt: number;
}

const sessions = new Map<string, Session>();

// In-flight rehydrations, so concurrent requests for the same cold session
// (clients typically reconnect their GET stream and POST at the same moment)
// share one transport instead of racing and orphaning the loser.
const rehydrating = new Map<string, Promise<Session>>();

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
      logger.info("Evicted idle MCP session from memory");
    }
  }
}, SWEEP_INTERVAL_MS);
sweep.unref?.();

function createServer(mcpToken: string): McpServer {
  const server = new McpServer(
    { name: "withings-mcp", version: "2.1.0" },
    { capabilities: { tools: {} } }
  );
  registerAllTools(server, mcpToken);
  return server;
}

/**
 * Rebuild a session this process has no memory of — after a restart, an idle
 * eviction, or because another instance handled the handshake.
 *
 * The transport is created *without* a `sessionIdGenerator`, which puts it in
 * stateless mode: `validateSession()` returns immediately instead of rejecting
 * the request with "Bad Request: Server not initialized", since the handshake
 * that would have set that flag happened in a process that no longer exists.
 * Assigning `sessionId` afterwards (a public field on the SDK's Transport
 * interface) makes the transport keep echoing the client's existing
 * Mcp-Session-Id, so the client never learns anything changed.
 *
 * Nothing else needs restoring: tool handlers close over the MCP token alone
 * and re-read every Withings credential from Supabase per call. The negotiated
 * client capabilities are lost, which is harmless here — all tools are
 * read-only and the server never initiates sampling, elicitation or roots.
 */
async function rehydrateSession(
  sessionId: string,
  mcpToken: string
): Promise<Session> {
  const transport = new WebStandardStreamableHTTPServerTransport({
    // Stateless mode passes `undefined` rather than the id, so close over it.
    onsessionclosed: () => {
      sessions.delete(sessionId);
      void sessionStore.delete(sessionId).catch((err) => {
        logger.warn("Failed to delete MCP session", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      logger.info("MCP session closed");
    },
  });
  transport.sessionId = sessionId;

  transport.onclose = () => {
    sessions.delete(sessionId);
  };

  await createServer(mcpToken).connect(transport);

  const session: Session = {
    transport,
    mcpToken,
    lastActivityAt: Date.now(),
    lastPersistedAt: Date.now(),
  };
  sessions.set(sessionId, session);
  logger.info("MCP session rehydrated from store");

  return session;
}

function getOrRehydrateSession(
  sessionId: string,
  mcpToken: string
): Promise<Session> {
  const inFlight = rehydrating.get(sessionId);
  if (inFlight) return inFlight;

  const pending = rehydrateSession(sessionId, mcpToken).finally(() => {
    rehydrating.delete(sessionId);
  });
  rehydrating.set(sessionId, pending);

  return pending;
}

/**
 * An initialize request always starts a fresh session, even if the client sent
 * a stale session id alongside it — there is nothing to rehydrate, and adopting
 * one would make the SDK reject the handshake as already initialized.
 *
 * `isInitializeRequest` is wrapped rather than passed to `.some()` directly:
 * `.some()` also supplies an index and the source array, so a future signature
 * change upstream would silently start feeding it the index.
 */
function isInitializeMessage(body: unknown): boolean {
  return Array.isArray(body)
    ? body.some((message) => isInitializeRequest(message))
    : isInitializeRequest(body);
}

/**
 * Resolve a session id this process has no memory of. Returning 404 is what the
 * spec prescribes, but no shipping client implements the "404 -> re-initialize"
 * contract (the SDK client never clears its session id), so a cold cache would
 * wedge the client until the whole app is restarted.
 */
async function resolveStoredSession(
  sessionId: string,
  mcpToken: string
): Promise<Session | "not_found" | "forbidden"> {
  const stored = await sessionStore.get(sessionId);
  if (!stored) return "not_found";
  if (stored.mcpToken !== mcpToken) return "forbidden";

  return getOrRehydrateSession(sessionId, mcpToken);
}

// Keep the stored session alive without adding a write to every tool call.
function touchSession(session: Session, sessionId: string): void {
  const now = Date.now();
  session.lastActivityAt = now;

  if (now - session.lastPersistedAt < ACTIVITY_PERSIST_INTERVAL_MS) return;

  session.lastPersistedAt = now;
  void sessionStore.touch(sessionId);
}

function forbidden(c: AppContext) {
  logger.warn("Session access denied: token does not match session owner");
  return c.json({ error: "forbidden" }, 403);
}

/**
 * Unified handler for /mcp endpoint (GET, POST, DELETE).
 * Uses the SDK's WebStandardStreamableHTTPServerTransport which handles
 * all protocol details internally (SSE streaming, JSON-RPC validation,
 * session lifecycle).
 */
export const handleMcp = async (c: AppContext) => {
  const mcpToken = c.get("accessToken");
  const sessionId = c.req.header("mcp-session-id");
  const parsedBody = c.get("parsedBody");

  let session = sessionId ? sessions.get(sessionId) : undefined;

  if (sessionId && !session && !isInitializeMessage(parsedBody)) {
    const resolved = await resolveStoredSession(sessionId, mcpToken);

    if (resolved === "not_found") {
      return c.json({ error: "invalid_session" }, 404);
    }
    if (resolved === "forbidden") {
      return forbidden(c);
    }

    session = resolved;
  }

  // Validate bearer token matches session owner
  if (session && session.mcpToken !== mcpToken) {
    return forbidden(c);
  }

  // Existing session — forward to its transport.
  // `parsedBody` is populated by the JSON body parser middleware that
  // `createMcpHonoApp` installs on the app, so the transport reuses it
  // instead of re-parsing the request body.
  if (session && sessionId) {
    touchSession(session, sessionId);
    return session.transport.handleRequest(c.req.raw, { parsedBody });
  }

  // No session — only POST can initialize
  if (c.req.method !== "POST") {
    return c.json({ error: "invalid_request" }, 400);
  }

  // New session — create transport + server
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: () => crypto.randomUUID(),
    onsessioninitialized: async (id) => {
      sessions.set(id, {
        transport,
        mcpToken,
        lastActivityAt: Date.now(),
        lastPersistedAt: Date.now(),
      });
      // Persist so the session outlives this process. A failure here only
      // costs restart-survivability, so degrade instead of failing the
      // handshake.
      try {
        await sessionStore.create(id, mcpToken);
      } catch (err) {
        logger.warn("Failed to persist MCP session", {
          error: err instanceof Error ? err.message : String(err),
        });
      }
      logger.info("MCP session established");
    },
    onsessionclosed: (id) => {
      sessions.delete(id);
      void sessionStore.delete(id).catch((err) => {
        logger.warn("Failed to delete MCP session", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      logger.info("MCP session closed");
    },
  });

  // Belt-and-suspenders: onsessionclosed only fires on explicit DELETE.
  // onclose fires whenever the transport itself is torn down (idle sweep,
  // server shutdown, internal SDK errors), so wire both. This one drops the
  // in-memory entry only — the stored session must survive a restart.
  transport.onclose = () => {
    if (transport.sessionId) sessions.delete(transport.sessionId);
  };

  await createServer(mcpToken).connect(transport);

  return transport.handleRequest(c.req.raw, { parsedBody });
};
