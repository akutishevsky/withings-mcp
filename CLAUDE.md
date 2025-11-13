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
│   └── token-store.ts       # MCP ↔ Withings token mapping
├── server/                   # Server components
│   ├── app.ts               # Hono app setup, route mounting, MCP_ENDPOINT constant
│   ├── mcp-endpoints.ts     # MCP GET/POST handlers for /mcp endpoint
│   └── middleware.ts        # Bearer token authentication
├── tools/                    # MCP tools organized by Withings API category
│   ├── index.ts             # Registers all tools on MCP server instances
│   ├── sleep.ts             # Sleep API: get_sleep_summary
│   ├── measure.ts           # Measure API: get_measures, get_workouts, get_activity, get_intraday_activity
│   ├── user.ts              # User API: get_user_devices, get_user_goals
│   ├── heart.ts             # Heart API: list_heart_records, get_heart_signal
│   └── stetho.ts            # Stetho API: list_stetho_records, get_stetho_signal
├── transport/               # MCP Protocol Implementation
│   └── mcp-transport.ts     # Custom SSE transport for MCP SDK
├── withings/                # Withings API Integration
│   └── api.ts               # Withings API client & request handling
├── utils/                    # Utilities
│   └── logger.ts            # Privacy-safe Pino logger configuration
└── index.ts                 # Main entry point (initializes stores & creates app)
```

### Logging

The server uses **Pino** for structured logging with strict privacy controls suitable for public repositories:

**Privacy-Safe Configuration** (src/utils/logger.ts):
- **NO** tokens, access codes, or authentication credentials
- **NO** user IDs, email addresses, or personal information
- **NO** API request/response payloads containing sensitive data
- **ONLY** operational events, errors, and minimal diagnostic information

**Log Levels:**
- `error`: Critical failures requiring attention
- `warn`: Non-critical issues or deprecations
- `info`: Important operational events (connections, disconnections)
- `debug`: Detailed diagnostic information (disabled in production)

**Redacted Fields:**
All sensitive fields are automatically redacted including: `token`, `access_token`, `code`, `client_secret`, `code_verifier`, `userid`, `email`, `password`, `sessionId`, `state`, and more.

**Environment Variables:**
- `LOG_LEVEL`: Set log level (default: `info`) - supports trace, debug, info, warn, error

**Component Loggers:**
Each module creates a child logger with context:
- `component: "oauth"` - Authentication flow events
- `component: "middleware"` - Request authentication
- `component: "mcp-endpoints"` - MCP session lifecycle
- `component: "tools:measure"` - Measure tool invocations
- `component: "tools:sleep"` - Sleep tool invocations
- `component: "tools:user"` - User tool invocations
- `component: "tools:heart"` - Heart tool invocations
- `component: "tools:stetho"` - Stetho tool invocations
- `component: "transport"` - Transport and session management

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
- **Endpoint**: The MCP endpoint is always `/mcp` (defined as `MCP_ENDPOINT` constant in src/server/app.ts)

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
- `LOG_LEVEL`: Logging level - trace, debug, info, warn, error (default: info)

See `.env.example` for template.

## MCP Tools

The server implements 11 MCP tools for accessing Withings health data, organized by Withings API category. All tools are registered via `registerAllTools()` (src/tools/index.ts) on per-session `McpServer` instances to ensure proper session isolation.

### Sleep Tools (src/tools/sleep.ts)

#### get_sleep_summary

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

### Measure Tools (src/tools/measure.ts)

#### get_measures

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

#### get_workouts

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

#### get_activity

Retrieves daily aggregated activity data including:
- Steps, distance, elevation (floors climbed)
- Activity durations (soft, moderate, intense)
- Calories (active and total)
- Heart rate metrics (average, min, max, zones)

**Parameters:**
- `startdateymd`: Start date (YYYY-MM-DD format)
- `enddateymd`: End date (YYYY-MM-DD format)
- `lastupdate`: Unix timestamp for sync (alternative to date range)
- `offset`: Pagination offset
- `data_fields`: Optional comma-separated list of specific fields

#### get_intraday_activity

Retrieves high-frequency intraday activity data captured throughout the day:
- Time-series data with timestamps
- Steps, elevation, calories, distance
- Swimming metrics (strokes, pool laps, duration)
- Heart rate and SpO2 measurements
- HRV metrics (RMSSD, SDNN1, quality score)

**Parameters:**
- `startdate`: Unix timestamp (optional)
- `enddate`: Unix timestamp (optional, max 24h from startdate)
- `data_fields`: Optional comma-separated list of specific fields

**Note:** If no dates provided, returns most recent data. Maximum 24-hour range.

### User Tools (src/tools/user.ts)

#### get_user_devices

Retrieves list of devices linked to the user's account:
- Device type and model (e.g., "Scale", "Body Cardio")
- Battery level
- MAC address and device ID
- Firmware version
- Network status and connectivity
- Timezone
- First and last session dates

**Parameters:** None required

#### get_user_goals

Retrieves the user's health and fitness goals:
- Steps: Daily step count target
- Sleep: Daily sleep duration target (in seconds)
- Weight: Target weight (with value and unit)

**Parameters:** None required

### Heart Tools (src/tools/heart.ts)

#### list_heart_records

Retrieves list of ECG (electrocardiogram) recordings:
- Signal IDs (for fetching full waveform data)
- Timestamps
- Heart rate measurements
- Afib (atrial fibrillation) detection results
- Blood pressure measurements (if taken with BPM Core)

**Parameters:**
- `startdate`: Unix timestamp (optional)
- `enddate`: Unix timestamp (optional)
- `offset`: Pagination offset (optional)

#### get_heart_signal

Retrieves detailed ECG waveform data in micro-volts (μV):
- Raw ECG signal data array
- Sampling frequency (500 Hz for BPM Core, 300 Hz for Move ECG/ScanWatch)
- Wear position information
- Recording duration: 20s (BPM Core), 30s (Move ECG/ScanWatch)

**Parameters:**
- `signalid`: Signal ID from list_heart_records (required)
- `with_filtered`: Request filtered signal version (optional)
- `with_intervals`: Include feature intervals (optional)

### Stetho Tools (src/tools/stetho.ts)

#### list_stetho_records

Retrieves list of stethoscope recordings:
- Signal IDs (for fetching full audio data)
- Timestamps
- Device IDs
- VHD (Valve Heart Disease) indicators
- Timezone information

**Parameters:**
- `startdate`: Unix timestamp (optional)
- `enddate`: Unix timestamp (optional)
- `offset`: Pagination offset (optional)

#### get_stetho_signal

Retrieves detailed stethoscope audio signal data:
- Raw audio signal data array
- Frequency (sampling rate)
- Duration, format, size, resolution
- Channel information
- Device model
- Stethoscope position
- VHD (Valve Heart Disease) indicator

**Parameters:**
- `signalid`: Signal ID from list_stetho_records (required)

### Adding New Tools

To add new Withings API tools:

1. Create a new file in `src/tools/` based on the Withings API category
2. Export a `register[Category]Tools()` function that takes `(server, mcpAccessToken)`
3. Import and call your registration function in `src/tools/index.ts`
4. Add corresponding API client functions to `src/withings/api.ts`
5. Add a component logger entry (e.g., `component: "tools:newcategory"`)

Implemented tool categories:
- Sleep API (sleep summary data)
- Measure API (health measures, workouts, activities)
- User API (devices, goals)
- Heart API (ECG recordings and signals)
- Stetho API (stethoscope recordings and signals)

Additional tool categories available in Withings API:
- Notify API (webhooks/notifications)
- Survey API (health surveys)

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
- Activity: `/v2/measure` with action `getactivity`
- Intraday Activity: `/v2/measure` with action `getintradayactivity`
- User Devices: `/v2/user` with action `getdevice`
- User Goals: `/v2/user` with action `getgoals`
- Heart List: `/v2/heart` with action `list`
- Heart Signal: `/v2/heart` with action `get`
- Stetho List: `/v2/stetho` with action `list`
- Stetho Signal: `/v2/stetho` with action `get`

**API Client** (src/withings/api.ts):
- `makeWithingsRequest()`: Generic authenticated request handler
- Automatically maps MCP tokens to Withings tokens via token store
- Error handling for Withings API status codes (status !== 0)
- All requests use POST with `application/x-www-form-urlencoded` content type
