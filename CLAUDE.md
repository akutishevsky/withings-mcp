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

### Project Structure

The codebase is organized by context into focused modules:

```
src/
├── auth/                     # Authentication & Authorization
│   ├── oauth.ts             # OAuth 2.0 endpoints (/authorize, /callback, /token, /register)
│   ├── token-store.ts       # MCP ↔ Withings token mapping
│   └── auth.ts              # Legacy auth (unused)
├── server/                   # Server components
│   ├── app.ts               # Hono app setup & route mounting
│   ├── mcp-endpoints.ts     # MCP GET/POST handlers for /mcp endpoint
│   └── middleware.ts        # Bearer token authentication
├── tools/                    # MCP tools organized by Withings API category
│   ├── index.ts             # Registers all tools on MCP server instances
│   ├── sleep.ts             # Sleep API: get_sleep_summary
│   └── measure.ts           # Measure API: get_measures, get_workouts
├── transport/               # MCP Protocol Implementation
│   └── mcp-transport.ts     # Custom SSE transport for MCP SDK
├── withings/                # Withings API Integration
│   └── api.ts               # Withings API client & request handling
└── index.ts                 # Main entry point (initializes stores & creates app)
```

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

**Session Management** (src/transport/mcp-transport.ts):
- Sessions timeout after 30 minutes of inactivity
- Heartbeat pings sent every 15 seconds to keep connections alive
- Sessions cleaned up automatically every minute

**Implementation** (src/server/mcp-endpoints.ts):
- `handleMcpGet()`: Creates SSE stream, registers tools, connects MCP server
- `handleMcpPost()`: Handles initial POST with SSE or forwards to existing session

### Data Storage

Uses **Deno KV** (@deno/kv) for persistent storage:

**Token Store** (src/auth/token-store.ts):
- Maps MCP tokens → Withings tokens (access, refresh, userId, expiry)
- Prefix: `["tokens", mcpToken]`

**OAuth Store** (src/auth/oauth.ts):
- OAuth sessions (10min TTL): `["oauth_sessions", sessionId]`
- Auth codes (10min TTL): `["auth_codes", code]`
- Registered clients: `["clients", clientId]`

## Environment Variables

Required:
- `WITHINGS_CLIENT_ID`: From Withings developer console
- `WITHINGS_CLIENT_SECRET`: From Withings developer console
- `WITHINGS_REDIRECT_URI`: Callback URL (must match Withings app settings)

Optional:
- `PORT`: Server port (default: 3000)

See `.env.example` for template.

## MCP Tools

The server implements three MCP tools for accessing Withings health data, organized by Withings API category. All tools are registered via `registerAllTools()` (src/tools/index.ts) on per-session `McpServer` instances to ensure proper session isolation.

### get_sleep_summary (src/tools/sleep.ts)

Retrieves sleep summary data including:
- Sleep duration and stages (light, deep, REM)
- Heart rate metrics during sleep
- Breathing quality
- Sleep score

**Parameters:**
- `startdateymd`: Start date (YYYY-MM-DD format)
- `enddateymd`: End date (YYYY-MM-DD format)
- `lastupdate`: Unix timestamp for sync (alternative to date range)
- `data_fields`: Optional comma-separated list of specific fields

### get_measures (src/tools/measure.ts)

Retrieves health measures with automatic type descriptions and calculated values:
- Weight, height, body composition (fat mass, muscle mass, bone mass)
- Blood pressure (systolic/diastolic)
- Heart rate and pulse wave velocity
- Temperature (body, skin)
- Advanced metrics (VO2 max, vascular age, metabolic age, BMR)
- ECG intervals, atrial fibrillation detection
- Body composition details (hydration, visceral fat, extracellular/intracellular water)

**Parameters:**
- `meastype`: Single measure type ID
- `meastypes`: Comma-separated list of measure type IDs
- `startdate`/`enddate`: Unix timestamps for date range
- `lastupdate`: Unix timestamp for sync
- `offset`: Pagination offset

**Response enhancement:** Each measure includes `type_description` and `calculated_value` fields added by the server.

### get_workouts (src/tools/measure.ts)

Retrieves workout summaries with comprehensive metrics:
- Calories burned and workout intensity
- Heart rate data (average, min, max, zones)
- Distance, steps, elevation
- Swimming metrics (laps, strokes, pool length)
- SpO2 levels and pause durations

**Parameters:**
- `startdateymd`: Start date (YYYY-MM-DD format)
- `enddateymd`: End date (YYYY-MM-DD format)
- `lastupdate`: Unix timestamp for sync
- `offset`: Pagination offset
- `data_fields`: Comma-separated list of fields (defaults to all fields)

**Response transformation:** The `category` field is removed from workout series.

### Adding New Tools

To add new Withings API tools:

1. Create a new file in `src/tools/` based on the Withings API category (e.g., `heart.ts`, `user.ts`)
2. Export a `register[Category]Tools()` function that takes `(server, mcpAccessToken)`
3. Import and call your registration function in `src/tools/index.ts`
4. Add corresponding API client functions to `src/withings/api.ts`

Example tool categories available:
- Heart API (heart rate data)
- User API (user profile, devices, goals)
- Activity API (daily activities, intraday data)
- Notify API (webhooks/notifications)

## Important Implementation Details

### PKCE Support

The OAuth implementation supports PKCE (Proof Key for Code Exchange) for enhanced security. The code verifier is validated in src/auth/oauth.ts using SHA-256 hashing.

### Session Isolation

Each SSE connection creates a **separate McpServer instance** (src/server/mcp-endpoints.ts). This ensures tools and state are isolated per session. Tools are registered per-session via `registerAllTools()` from src/tools/index.ts.

### Transport Lifecycle

- Transport attached to stream before server connection
- `handleIncomingMessage()` is called directly on transport from POST endpoint
- Transport cleanup handled automatically on abort signal

### Tool Registration

Tools are registered using a centralized approach:
- Each tool category has its own file in `src/tools/`
- `src/tools/index.ts` provides `registerAllTools()` to register all tools at once
- Tools receive the `mcpAccessToken` as a closure parameter for authentication

## Withings API Integration

**Authentication:**
- Auth URL: `https://account.withings.com/oauth2_user/authorize2`
- Token URL: `https://wbsapi.withings.net/v2/oauth2`
- Scopes: `user.metrics,user.activity`
- Token response format uses `action: "requesttoken"` and returns `status: 0` on success

**API Endpoints** (src/withings/api.ts):
- Base URL: `https://wbsapi.withings.net`
- Sleep: `/v2/sleep` with action `getsummary`
- Measures: `/measure` with action `getmeas`
- Workouts: `/v2/measure` with action `getworkouts`

**API Client** (src/withings/api.ts):
- `makeWithingsRequest()`: Generic authenticated request handler
- Automatically maps MCP tokens to Withings tokens via token store
- Error handling for Withings API status codes (status !== 0)
- All requests use POST with `application/x-www-form-urlencoded` content type
