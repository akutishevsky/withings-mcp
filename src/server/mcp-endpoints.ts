import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { HonoSSETransport, sessionManager } from "../transport/mcp-transport.js";
import { registerAllTools } from "../tools/index.js";

/**
 * GET handler for /mcp endpoint - Initiates SSE stream for MCP
 */
export const handleMcpGet = async (c: any) => {
  // Get or create session ID
  const sessionId = c.req.header("Mcp-Session-Id") || crypto.randomUUID();

  // Get the MCP access token from context
  const mcpAccessToken = (c as any).get("accessToken") as string;

  // Check for existing session
  const existingSession = sessionManager.getSession(sessionId);
  if (existingSession) {
    // Close existing transport if any
    await existingSession.transport.close();
    sessionManager.deleteSession(sessionId);
  }

  // Create a ReadableStream for SSE
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  // Helper to write SSE events
  const writeSSE = async (data: string, event?: string) => {
    try {
      if (event) {
        await writer.write(encoder.encode(`event: ${event}\n`));
      }
      await writer.write(encoder.encode(`data: ${data}\n\n`));
    } catch (error) {
      // Silently handle write errors
    }
  };

  // Create transport
  const transport = new HonoSSETransport();
  transport.attachStream({
    writeSSE: async (data: { data: string; event?: string; id?: string }) => {
      await writeSSE(data.data, data.event);
    },
    close: () => {
      writer.close();
    },
  });

  // Start async initialization
  (async () => {
    try {
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

      // Register all Withings tools
      registerAllTools(sessionServer, mcpAccessToken);

      try {
        // Connect server to transport
        await sessionServer.connect(transport);

        // Store session
        sessionManager.createSession(sessionId, transport);

        // Handle connection close
        c.req.raw.signal.addEventListener("abort", () => {
          sessionManager.deleteSession(sessionId);
        });

        // Keep connection alive - send heartbeat
        const heartbeat = setInterval(async () => {
          try {
            await writeSSE("", "ping");
          } catch (error) {
            clearInterval(heartbeat);
          }
        }, 15000);

        // Cleanup on abort
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          sessionManager.deleteSession(sessionId);
        });

      } catch (error) {
        sessionManager.deleteSession(sessionId);
        writer.close();
      }
    } catch (error) {
      writer.close();
    }
  })();

  // Return SSE response with proper headers immediately
  const headers = {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
    "Mcp-Session-Id": sessionId,
  };

  const response = new Response(readable, { headers });

  return response;
};

/**
 * POST handler for /mcp endpoint - Receives JSON-RPC messages from client
 */
export const handleMcpPost = async (c: any) => {
  let sessionId = c.req.header("Mcp-Session-Id");
  const mcpToken = (c as any).get("accessToken") as string;

  // If no session ID, this is an initial POST that should establish SSE stream
  if (!sessionId) {
    sessionId = crypto.randomUUID();

    // Get the JSON-RPC message first
    const message = await c.req.json() as JSONRPCMessage;

    // Create SSE stream for response
    const { readable, writable } = new TransformStream();
    const writer = writable.getWriter();
    const encoder = new TextEncoder();

    const writeSSE = async (data: string, event?: string) => {
      try {
        if (event) {
          await writer.write(encoder.encode(`event: ${event}\n`));
        }
        await writer.write(encoder.encode(`data: ${data}\n\n`));
      } catch (error) {
        // Silently handle write errors
      }
    };

    // Create transport
    const transport = new HonoSSETransport();
    transport.attachStream({
      writeSSE: async (data: { data: string; event?: string; id?: string }) => {
        await writeSSE(data.data, data.event);
      },
      close: () => {
        writer.close();
      },
    });

    // Start async initialization
    (async () => {
      try {
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

        // Register all Withings tools
        registerAllTools(sessionServer, mcpToken);

        // Connect server to transport
        await sessionServer.connect(transport);

        // Store session
        sessionManager.createSession(sessionId!, transport);

        // Handle the initial message
        await transport.handleIncomingMessage(message);

        // Handle connection close
        c.req.raw.signal.addEventListener("abort", () => {
          sessionManager.deleteSession(sessionId!);
        });

        // Keep connection alive - send heartbeat
        const heartbeat = setInterval(async () => {
          try {
            await writeSSE("", "ping");
          } catch (error) {
            clearInterval(heartbeat);
          }
        }, 15000);

        // Cleanup on abort
        c.req.raw.signal.addEventListener("abort", () => {
          clearInterval(heartbeat);
          sessionManager.deleteSession(sessionId!);
        });

      } catch (error) {
        sessionManager.deleteSession(sessionId!);
        writer.close();
      }
    })();

    // Return SSE response with session ID header
    const headers = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
      "Mcp-Session-Id": sessionId,
    };

    return new Response(readable, { headers });
  }

  // Existing session - handle message and return 202
  const session = sessionManager.getSession(sessionId);
  if (!session) {
    return c.json({
      error: "invalid_session",
      error_description: "Session not found or expired"
    }, 404);
  }

  try {
    const message = await c.req.json() as JSONRPCMessage;

    // Forward message to transport
    await session.transport.handleIncomingMessage(message);

    // Return 202 Accepted (response will come via SSE)
    return c.body(null, 202);
  } catch (error) {
    return c.json({
      error: "internal_error",
      error_description: "Failed to process message"
    }, 500);
  }
};
