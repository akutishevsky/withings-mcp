import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "transport" });

export interface SSEStream {
  writeSSE: (data: { data: string; event?: string; id?: string }) => Promise<void>;
  close: () => void;
}

/**
 * Custom SSE transport for MCP that works with Hono streaming
 */
export class HonoSSETransport implements Transport {
  private stream: SSEStream | null = null;
  private messageHandler: ((message: JSONRPCMessage) => Promise<void>) | null = null;
  private errorHandler: ((error: Error) => void) | null = null;
  private closeHandler: (() => void) | null = null;
  private _closed = false;

  async start(): Promise<void> {
    // Transport is started when stream is attached
  }

  attachStream(stream: SSEStream): void {
    this.stream = stream;
  }

  async send(message: JSONRPCMessage): Promise<void> {
    if (this._closed) {
      throw new Error("Transport is closed");
    }

    if (!this.stream) {
      throw new Error("SSE stream not attached");
    }

    try {
      await this.stream.writeSSE({
        data: JSON.stringify(message),
        event: "message",
      });
    } catch (error) {
      if (this.errorHandler) {
        this.errorHandler(error as Error);
      }
      throw error;
    }
  }

  async handleIncomingMessage(message: JSONRPCMessage): Promise<void> {
    if (this._closed) {
      return;
    }

    if (this.messageHandler) {
      try {
        await this.messageHandler(message);
      } catch (error) {
        if (this.errorHandler) {
          this.errorHandler(error as Error);
        }
      }
    }
  }

  async close(): Promise<void> {
    if (this._closed) {
      return;
    }

    this._closed = true;
    logger.info("Transport closed");

    if (this.stream) {
      this.stream.close();
      this.stream = null;
    }

    if (this.closeHandler) {
      this.closeHandler();
    }
  }

  // Properties for Transport interface (not methods!)
  set onclose(handler: () => void) {
    this.closeHandler = handler;
  }

  get onclose(): () => void {
    return this.closeHandler || (() => {});
  }

  set onerror(handler: (error: Error) => void) {
    this.errorHandler = handler;
  }

  get onerror(): (error: Error) => void {
    return this.errorHandler || (() => {});
  }

  set onmessage(handler: (message: JSONRPCMessage) => Promise<void>) {
    this.messageHandler = handler;
  }

  get onmessage(): (message: JSONRPCMessage) => Promise<void> {
    return this.messageHandler || (async () => {});
  }
}

/**
 * Session manager for MCP connections
 */
interface MCPSession {
  transport: HonoSSETransport;
  sessionId: string;
  createdAt: number;
  lastActivity: number;
}

class SessionManager {
  private sessions = new Map<string, MCPSession>();
  private readonly SESSION_TIMEOUT = 30 * 60 * 1000; // 30 minutes

  createSession(sessionId: string, transport: HonoSSETransport): void {
    this.sessions.set(sessionId, {
      transport,
      sessionId,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    });
  }

  getSession(sessionId: string): MCPSession | undefined {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.lastActivity = Date.now();
    }
    return session;
  }

  deleteSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.transport.close().catch(() => {});
      this.sessions.delete(sessionId);
    }
  }

  cleanup(): void {
    const now = Date.now();
    let cleanedCount = 0;
    for (const [sessionId, session] of this.sessions.entries()) {
      if (now - session.lastActivity > this.SESSION_TIMEOUT) {
        this.deleteSession(sessionId);
        cleanedCount++;
      }
    }
    if (cleanedCount > 0) {
      logger.info(`Cleaned up ${cleanedCount} expired session(s)`);
    }
  }

  startCleanup(): void {
    setInterval(() => this.cleanup(), 60 * 1000); // Run every minute
  }
}

export const sessionManager = new SessionManager();
sessionManager.startCleanup();
