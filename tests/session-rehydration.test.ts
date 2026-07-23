/**
 * Tests for the MCP session rehydration mechanism (src/server/mcp-endpoints.ts).
 *
 * After a restart / idle eviction this server rebuilds a session the process has
 * no memory of, instead of forcing every connected client to re-handshake. That
 * trick leans on three pieces of SDK behaviour that are real but undocumented,
 * and which a future `@modelcontextprotocol/server` bump could silently remove:
 *
 *   1. A transport constructed WITHOUT `sessionIdGenerator` runs in stateless
 *      mode, where `validateSession()` bails out immediately
 *      (`if (this.sessionIdGenerator === void 0) return;`) rather than rejecting
 *      the request with "Bad Request: Server not initialized".
 *   2. `sessionId` is a public, mutable field on the transport, and every
 *      header-emitting branch is guarded only by `sessionId !== undefined`, so
 *      assigning it makes responses keep echoing the client's original id.
 *   3. A stateless transport can be REUSED across many requests. SDK v1
 *      explicitly banned this; v2 silently dropped the guard. Upstream PR
 *      typescript-sdk#2421 intends to restore it.
 *
 * These tests drive the SDK directly (transport + `McpServer` + web-standard
 * `Request` objects) rather than going through Hono, so they fail on an SDK
 * regression and nothing else.
 */

import { describe, expect, test } from "bun:test";
import {
  isInitializeRequest,
  McpServer,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import { z } from "zod";

const MCP_URL = "http://localhost/mcp";

/** A session id that was handed out by a process which no longer exists. */
const PRE_EXISTING_SESSION_ID = "11111111-2222-3333-4444-555555555555";

/** Mirrors the production server: an McpServer with at least one real tool. */
function createTestServer(): McpServer {
  const server = new McpServer(
    { name: "rehydration-test", version: "0.0.0" },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    "echo",
    {
      title: "Echo",
      description: "Returns its input, so tools/call has something to assert.",
      inputSchema: z.object({ value: z.string() }),
    },
    ({ value }) => ({ content: [{ type: "text" as const, text: `echo:${value}` }] })
  );

  return server;
}

/**
 * Build a rehydrated transport exactly the way `rehydrateSession()` does:
 * stateless mode (no `sessionIdGenerator`) plus a hand-assigned `sessionId`.
 */
async function rehydrateTransport(
  sessionId: string,
  onsessionclosed?: (id?: string) => void
): Promise<WebStandardStreamableHTTPServerTransport> {
  const transport = new WebStandardStreamableHTTPServerTransport(
    onsessionclosed ? { onsessionclosed } : {}
  );
  transport.sessionId = sessionId;
  await createTestServer().connect(transport);
  return transport;
}

function postRequest(body: unknown, sessionId?: string): Request {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  return new Request(MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function deleteRequest(sessionId: string): Request {
  return new Request(MCP_URL, {
    method: "DELETE",
    headers: { "mcp-session-id": sessionId },
  });
}

interface JsonRpcEnvelope {
  jsonrpc: string;
  id?: unknown;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

/**
 * Responses are SSE by default (`event: message` / `data: {...}`); fall back to
 * plain JSON for `enableJsonResponse` transports and for SDK error responses,
 * which are always `Response.json(...)`.
 */
async function readJsonRpc(response: Response): Promise<JsonRpcEnvelope> {
  const text = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  if (!contentType.includes("text/event-stream")) {
    return JSON.parse(text) as JsonRpcEnvelope;
  }

  const dataLine = text
    .split("\n")
    .find((line) => line.startsWith("data: "));
  if (!dataLine) {
    throw new Error(`No SSE data line in response payload: ${text}`);
  }

  return JSON.parse(dataLine.slice("data: ".length)) as JsonRpcEnvelope;
}

function toolsListRequest(id: number): Record<string, unknown> {
  return { jsonrpc: "2.0", id, method: "tools/list", params: {} };
}

function toolsCallRequest(id: number, value: string): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: { name: "echo", arguments: { value } },
  };
}

function initializeMessage(id: number = 1): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test-client", version: "0.0.0" },
    },
  };
}

/** The SDK's per-request bookkeeping, reachable only through a cast. */
interface TransportInternals {
  _streamMapping: Map<unknown, unknown>;
  _requestToStreamMapping: Map<unknown, unknown>;
  _requestResponseMap: Map<unknown, unknown>;
}

function internals(
  transport: WebStandardStreamableHTTPServerTransport
): TransportInternals {
  return transport as unknown as TransportInternals;
}

describe("MCP session rehydration", () => {
  describe("baseline: what a restart used to do", () => {
    test("a fresh STATEFUL transport rejects a pre-existing session id with 400", async () => {
      // This is the bug rehydration exists to fix: after a restart every client
      // still holds a session id, but the new process has a virgin stateful
      // transport whose `_initialized` flag is false, so `validateSession()`
      // rejects the request outright.
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      await createTestServer().connect(transport);

      const response = await transport.handleRequest(
        postRequest(toolsListRequest(1), PRE_EXISTING_SESSION_ID)
      );

      expect(response.status).toBe(400);

      const body = await readJsonRpc(response);
      expect(body.error?.message).toContain("Server not initialized");

      await transport.close();
    });
  });

  describe("rehydration", () => {
    test("a stateless transport with an assigned sessionId serves tools/list", async () => {
      const transport = await rehydrateTransport(PRE_EXISTING_SESSION_ID);

      const response = await transport.handleRequest(
        postRequest(toolsListRequest(1), PRE_EXISTING_SESSION_ID)
      );

      expect(response.status).toBe(200);

      const body = await readJsonRpc(response);
      expect(body.error).toBeUndefined();

      const tools = body.result?.tools as Array<{ name: string }> | undefined;
      expect(tools?.map((tool) => tool.name)).toContain("echo");

      await transport.close();
    });

    test("a rehydrated transport serves tools/call", async () => {
      const transport = await rehydrateTransport(PRE_EXISTING_SESSION_ID);

      const response = await transport.handleRequest(
        postRequest(toolsCallRequest(2, "hello"), PRE_EXISTING_SESSION_ID)
      );

      expect(response.status).toBe(200);

      const body = await readJsonRpc(response);
      expect(body.error).toBeUndefined();

      const content = body.result?.content as
        | Array<{ type: string; text: string }>
        | undefined;
      expect(content?.[0]?.text).toBe("echo:hello");

      await transport.close();
    });

    test("the client's original session id is echoed back", async () => {
      // Header emission is guarded only by `sessionId !== undefined`, so the
      // hand-assigned id keeps flowing back and the client never learns that
      // the session was rebuilt.
      const transport = await rehydrateTransport(PRE_EXISTING_SESSION_ID);

      const response = await transport.handleRequest(
        postRequest(toolsListRequest(1), PRE_EXISTING_SESSION_ID)
      );

      expect(response.headers.get("mcp-session-id")).toBe(
        PRE_EXISTING_SESSION_ID
      );

      await response.text();
      await transport.close();
    });

    test("a GET stream on a rehydrated transport is accepted", async () => {
      // `handleMcp` forwards GET (the client's server-to-client SSE stream) to
      // the same rehydrated transport, so `validateSession()` must let it past.
      const transport = await rehydrateTransport(PRE_EXISTING_SESSION_ID);

      const response = await transport.handleRequest(
        new Request(MCP_URL, {
          method: "GET",
          headers: {
            Accept: "text/event-stream",
            "mcp-session-id": PRE_EXISTING_SESSION_ID,
          },
        })
      );

      expect(response.status).toBe(200);
      expect(response.headers.get("mcp-session-id")).toBe(
        PRE_EXISTING_SESSION_ID
      );

      await transport.close();
      await response.body?.cancel().catch(() => {});
    });
  });

  describe("transport reuse (guards typescript-sdk#2421)", () => {
    test("one rehydrated transport serves many sequential requests without leaking", async () => {
      // SDK v1 threw when a stateless transport handled a second request; v2
      // dropped that guard, which is what makes a single long-lived rehydrated
      // transport per session viable. Upstream PR #2421 wants the guard back.
      //
      // IF THIS TEST FAILS AFTER AN SDK BUMP: the reuse guard was most likely
      // reinstated. Rehydration then needs reworking — e.g. building a fresh
      // transport per request, or restoring real stateful sessions — rather
      // than relaxing this assertion.
      const transport = await rehydrateTransport(PRE_EXISTING_SESSION_ID);
      const REQUEST_COUNT = 50;

      for (let i = 0; i < REQUEST_COUNT; i++) {
        const request =
          i % 2 === 0
            ? toolsListRequest(i)
            : toolsCallRequest(i, `call-${i}`);

        const response = await transport.handleRequest(
          postRequest(request, PRE_EXISTING_SESSION_ID)
        );

        expect(response.status).toBe(200);

        const body = await readJsonRpc(response);
        expect(body.error).toBeUndefined();
        expect(body.id).toBe(i);
      }

      // Per-request bookkeeping must be torn down as each response completes,
      // otherwise a long-lived rehydrated transport is a memory leak.
      const maps = internals(transport);
      expect(maps._streamMapping).toBeInstanceOf(Map);
      expect(maps._requestToStreamMapping).toBeInstanceOf(Map);
      expect(maps._requestResponseMap).toBeInstanceOf(Map);

      expect(maps._streamMapping.size).toBe(0);
      expect(maps._requestToStreamMapping.size).toBe(0);
      expect(maps._requestResponseMap.size).toBe(0);

      await transport.close();
    });
  });

  describe("session teardown", () => {
    test("DELETE fires onsessionclosed on a rehydrated transport", async () => {
      // `rehydrateSession()` relies on this to drop the Supabase row when a
      // client explicitly ends the session.
      let closedCalls = 0;
      const transport = await rehydrateTransport(PRE_EXISTING_SESSION_ID, () => {
        closedCalls++;
      });

      const response = await transport.handleRequest(
        deleteRequest(PRE_EXISTING_SESSION_ID)
      );

      expect(response.status).toBe(200);
      expect(closedCalls).toBe(1);
    });

    test("onclose fires when a rehydrated transport is torn down", async () => {
      // The idle sweep closes transports directly, so `onclose` is the hook
      // that drops the in-memory Map entry.
      let closed = false;
      const transport = await rehydrateTransport(PRE_EXISTING_SESSION_ID);
      transport.onclose = () => {
        closed = true;
      };

      await transport.close();

      expect(closed).toBe(true);
    });
  });

  describe("isInitializeMessage semantics", () => {
    // `isInitializeMessage` is not exported, so its two dependencies are tested
    // directly: `isInitializeRequest`'s behaviour, and `Array.prototype.some`
    // over it. `handleMcp` calls it on EVERY request — including GET and DELETE,
    // which have no body at all — so it must tolerate `undefined`.

    test("recognises a single initialize message", () => {
      expect(isInitializeRequest(initializeMessage())).toBe(true);
    });

    test("recognises an array containing an initialize message", () => {
      const batch = [
        { jsonrpc: "2.0", method: "notifications/initialized" },
        initializeMessage(7),
      ];

      expect(batch.some((message) => isInitializeRequest(message))).toBe(true);
    });

    test("rejects a non-initialize message", () => {
      expect(isInitializeRequest(toolsListRequest(1))).toBe(false);
      expect(
        [toolsListRequest(1), toolsCallRequest(2, "x")].some((message) =>
          isInitializeRequest(message)
        )
      ).toBe(false);
    });

    test("returns false for undefined without throwing (the GET/DELETE case)", () => {
      expect(() => isInitializeRequest(undefined)).not.toThrow();
      expect(isInitializeRequest(undefined)).toBe(false);
      expect(isInitializeRequest(null)).toBe(false);
    });

    test("is not confused by the extra arguments Array#some passes", () => {
      // The production wrapper is `body.some((m) => isInitializeRequest(m))`
      // rather than `body.some(isInitializeRequest)` precisely so the index and
      // source array are never forwarded. Assert the arity assumption holds.
      expect(isInitializeRequest.length).toBeLessThanOrEqual(1);
    });
  });
});
