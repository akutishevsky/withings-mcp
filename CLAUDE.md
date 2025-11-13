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

- **src/index.ts**: Main entry point, Hono app setup, MCP endpoint handlers, tool registration
- **src/oauth.ts**: OAuth 2.0 endpoints (`/authorize`, `/callback`, `/token`, `/register`)
- **src/mcp-transport.ts**: Custom SSE Transport implementation for MCP SDK
- **src/token-store.ts**: MCP-to-Withings token mapping
- **src/withings-api.ts**: Withings API client functions and request handling
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

The server implements three MCP tools for accessing Withings health data. All tools are registered on per-session `McpServer` instances (see src/index.ts:147-349) to ensure proper session isolation:

### get_sleep_summary
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

### get_measures
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

**Response enhancement:** Each measure includes `type_description` and `calculated_value` fields added by the server (src/index.ts:256-271).

### get_workouts
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

**Response transformation:** The `category` field is removed from workout series (src/index.ts:320-326).

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

**Authentication:**
- Auth URL: `https://account.withings.com/oauth2_user/authorize2`
- Token URL: `https://wbsapi.withings.net/v2/oauth2`
- Scopes: `user.metrics,user.activity`
- Token response format uses `action: "requesttoken"` and returns `status: 0` on success

**API Endpoints** (src/withings-api.ts):
- Base URL: `https://wbsapi.withings.net`
- Sleep: `/v2/sleep` with action `getsummary`
- Measures: `/measure` with action `getmeas`
- Workouts: `/v2/measure` with action `getworkouts`

**API Client** (src/withings-api.ts:8):
- `makeWithingsRequest()`: Generic authenticated request handler
- Automatically maps MCP tokens to Withings tokens via token store
- Error handling for Withings API status codes (status !== 0)
- All requests use POST with `application/x-www-form-urlencoded` content type
