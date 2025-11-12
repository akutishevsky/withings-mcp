# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is an MCP (Model Context Protocol) server that integrates Withings health data with Claude. It implements OAuth 2.0 authentication with PKCE support and uses Server-Sent Events (SSE) for real-time bidirectional communication between Claude Desktop and the server.

## Development Commands

### Building
```bash
npm run build        # Compile TypeScript to JavaScript (outputs to ./build)
npm run dev          # Watch mode - recompile on changes
```

### Running
```bash
npm start            # Run the compiled server (requires build first)
deno run --allow-net --allow-env --allow-read --allow-write build/index.js  # Run with Deno
```

### Deployment
```bash
deno deploy --prod   # Deploy to Deno Deploy
```

## Architecture

### OAuth 2.0 Flow Architecture

The server implements a **double OAuth flow** to bridge MCP clients with Withings:

1. **MCP Client ↔ This Server**: Standard OAuth 2.0 with PKCE (MCP specification)
2. **This Server ↔ Withings API**: Withings-specific OAuth 2.0

**Flow sequence**:
- MCP client discovers server via `/.well-known/oauth-authorization-server`
- Client initiates OAuth at `/authorize` → server redirects to Withings
- Withings redirects back to `/callback` → server generates auth code
- Client exchanges code at `/token` → server exchanges Withings code and returns MCP access token
- MCP access tokens map to Withings tokens in storage

### MCP Transport Layer

The server uses **SSE (Server-Sent Events)** for MCP communication per the specification:

- **GET /mcp**: Establishes SSE stream for server-to-client messages. Each connection gets a unique `Mcp-Session-Id` and creates a new `McpServer` instance.
- **POST /mcp**: Receives JSON-RPC messages from client, forwarded to the session's transport.
- **Authentication**: Bearer token (MCP access token) required in `Authorization` header.

**Session Management** (src/mcp-transport.ts:118):
- Sessions timeout after 30 minutes of inactivity
- Heartbeat pings sent every 15 seconds to keep connections alive
- Sessions cleaned up automatically every minute

### Data Storage

Uses **Deno KV** (@deno/kv) for persistent storage:

**Token Store** (src/token-store.ts):
- Maps MCP tokens → Withings tokens (access, refresh, userId, expiry)
- Prefix: `["tokens", mcpToken]`

**OAuth Store** (src/oauth.ts:36):
- OAuth sessions (10min TTL): `["oauth_sessions", sessionId]`
- Auth codes (10min TTL): `["auth_codes", code]`
- Registered clients: `["clients", clientId]`

### Key Files

- **src/index.ts**: Main entry point, Hono app setup, MCP endpoint handlers
- **src/oauth.ts**: OAuth 2.0 endpoints (`/authorize`, `/callback`, `/token`, `/register`)
- **src/mcp-transport.ts**: Custom SSE Transport implementation for MCP SDK
- **src/token-store.ts**: MCP-to-Withings token mapping
- **src/auth.ts**: Legacy auth implementation (unused in current implementation)

## Environment Variables

Required:
- `WITHINGS_CLIENT_ID`: From Withings developer console
- `WITHINGS_CLIENT_SECRET`: From Withings developer console
- `WITHINGS_REDIRECT_URI`: Callback URL (must match Withings app settings)

Optional:
- `PORT`: Server port (default: 3000)

See `.env.example` for template.

## MCP Tools

Currently no tools are registered (see TODO comments in src/index.ts:39 and src/index.ts:99). Tools should be registered on the per-session `McpServer` instance created in the GET /mcp endpoint, not on the global instance.

## Important Implementation Details

### PKCE Support
The OAuth implementation supports PKCE (Proof Key for Code Exchange) for enhanced security. The code verifier is validated in src/oauth.ts:219 using SHA-256 hashing.

### Session Isolation
Each SSE connection creates a **separate McpServer instance** (src/index.ts:87). This ensures tools and state are isolated per session. DO NOT register tools on the global `mcpServer` instance created at src/index.ts:27.

### Transport Lifecycle
- Transport attached to stream before server connection
- `handleIncomingMessage()` is called directly on transport from POST endpoint
- Transport cleanup handled automatically on abort signal

## Withings API Integration

- Auth URL: `https://account.withings.com/oauth2_user/authorize2`
- Token URL: `https://wbsapi.withings.net/v2/oauth2`
- Scopes: `user.metrics,user.activity`
- Token response format uses `action: "requesttoken"` and returns `status: 0` on success
