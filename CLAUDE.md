# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## General Rules

Always execute tasks in parallel when possible. If multiple independent operations need to be performed (e.g., reading files, running searches, editing unrelated files, running builds), do them simultaneously rather than sequentially. Only run tasks sequentially when there is a dependency between them.

## Project Overview

This is an MCP (Model Context Protocol) server that integrates Withings health data with Claude. It implements OAuth 2.0 authentication with PKCE support and uses the Streamable HTTP transport (via the SDK's `WebStandardStreamableHTTPServerTransport`) for communication between MCP clients and the server.

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
├── db/                       # Database Layer (Supabase)
│   ├── supabase.ts          # Supabase client initialization
│   ├── types.ts             # TypeScript types for database rows
│   └── cleanup.ts           # Expired record cleanup scheduler
├── server/                   # Server components
│   ├── app.ts               # Hono app setup, route mounting, MCP_ENDPOINT constant
│   ├── mcp-endpoints.ts     # Unified MCP handler for /mcp endpoint (GET/POST/DELETE)
│   ├── middleware.ts        # Bearer token authentication
│   └── rate-limiter.ts      # Rate limiting middleware using Supabase
├── tools/                    # MCP tools organized by Withings API category
│   ├── index.ts             # Registers all tools on MCP server instances
│   ├── sleep.ts             # Sleep API: get_sleep, get_sleep_summary
│   ├── measure.ts           # Measure API: get_measures, get_workouts, get_activity, get_intraday_activity
│   ├── user.ts              # User API: get_user_devices, get_user_goals
│   ├── heart.ts             # Heart API: list_heart_records, get_heart_signal
│   └── stetho.ts            # Stetho API: list_stetho_records, get_stetho_signal
├── withings/                # Withings API Integration
│   └── api.ts               # Withings API client & request handling
├── utils/                    # Utilities
│   ├── logger.ts            # Privacy-safe custom logger for Deno Deploy
│   ├── encryption.ts        # AES-256-GCM encryption for sensitive tokens
│   └── timestamp.ts         # Timezone-aware timestamp conversion utilities
└── index.ts                 # Main entry point (initializes Supabase, stores & creates app)

public/
└── styles/                      # External CSS (no unsafe-inline CSP)
    ├── index.css               # Landing page styles
    └── health.css              # Health check page styles

supabase/
└── migrations/
    ├── 001_initial_schema.sql  # Database schema (tables, indexes)
    └── 004_atomic_rate_limit.sql # Atomic rate limit PostgreSQL function
```

### Logging

The server uses a **custom logger** optimized for Deno Deploy with strict privacy controls suitable for public repositories:

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
- `trace`: Very detailed diagnostic information

**Log Format:**
Logs are output in a readable plain-text format: `LEVEL [component] message {optional data}`

Example: `INFO [oauth] Starting OAuth authorization flow`

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
- `component: "supabase"` - Database client initialization
- `component: "cleanup"` - Expired record cleanup operations

### Date and Timestamp Handling

The server provides bidirectional date/timestamp conversion utilities (src/utils/timestamp.ts):

#### Input: YYYY-MM-DD → Unix Timestamp

MCP tools accept dates in human-readable YYYY-MM-DD format (e.g., "2025-11-17") which are automatically converted to Unix timestamps before calling the Withings API.

**Function:** `dateToUnixTimestamp(dateString: string): number`
- Accepts: YYYY-MM-DD format (e.g., "2025-11-17")
- Returns: Unix timestamp in seconds since epoch (midnight UTC)
- Validates: Format, month (1-12), day (1-31), and date validity
- Throws: Clear errors for invalid dates

**Used by:** Tools that accept date parameters (`get_sleep`, `get_measures`, `get_intraday_activity`, `list_heart_records`, `list_stetho_records`)

#### Output: Unix Timestamp → Timezone-Aware Datetime

The server automatically converts Unix timestamps in API responses to human-readable datetime strings using timezone information from the Withings API.

**Conversion Behavior:**
- **With timezone field**: Timestamps are converted to localized datetime in the format `"2024-01-15 12:30:00 Europe/Paris"`
- **Without timezone field**: Timestamps fall back to UTC ISO 8601 format `"2024-01-15T11:30:00.000Z"`
- Original Unix timestamp values are **replaced** with readable datetime strings in tool responses

**Timestamp Fields Converted:**
`startdate`, `enddate`, `date`, `created`, `modified`, `timestamp`, `first_session_date`, `last_session_date`, `birthdate`, `lastupdate`

**Special Handling:**
- **night_events** in sleep data: Array of timestamps converted to localized datetime strings
- **Nested objects**: Recursively processes all nested timestamp fields

**Example Transformation:**
```javascript
// Input (from Withings API)
{
  "timezone": "Europe/Paris",
  "startdate": 1705318200,
  "enddate": 1705347000
}

// Output (returned to MCP client)
{
  "timezone": "Europe/Paris",
  "startdate": "2024-01-15 12:30:00 Europe/Paris",
  "enddate": "2024-01-15 20:30:00 Europe/Paris"
}
```

**Implementation Functions:**
- `dateToUnixTimestamp()`: Converts YYYY-MM-DD to Unix timestamp
- `formatTimestamp()`: Converts to UTC ISO 8601
- `formatTimestampWithTimezone()`: Converts to localized datetime using Intl.DateTimeFormat
- `addReadableTimestamps()`: Recursively processes objects and replaces timestamp fields
- `addReadableNightEvents()`: Special handler for sleep data night_events arrays

### OAuth 2.0 Flow Architecture

The server implements a **double OAuth flow** to bridge MCP clients with Withings:

1. **MCP Client ↔ This Server**: Standard OAuth 2.0 with PKCE (MCP specification)
2. **This Server ↔ Withings API**: Withings-specific OAuth 2.0

**Flow sequence**:
- MCP client discovers server via `/.well-known/oauth-authorization-server`
- Client initiates OAuth at `/authorize` → server validates `client_id` against registered clients and `redirect_uri` against the client's registered URIs, then redirects to Withings
- Withings redirects back to `/callback` → server generates auth code
- Client exchanges code at `/token` → auth code is atomically consumed (single-use per RFC 6749), server exchanges Withings code and returns MCP access token
- MCP access tokens map to Withings tokens in storage

**OAuth Security**:
- **Redirect URI validation**: `/authorize` requires a registered `client_id` and validates `redirect_uri` against the client's registered URIs to prevent open redirect attacks
- **Single-use auth codes**: Auth codes are atomically consumed via `DELETE ... RETURNING` to prevent replay attacks
- **Auth code encryption**: Withings authorization codes are encrypted at rest using AES-256-GCM before storage in `auth_codes` table
- **Startup validation**: Server fails fast if required environment variables (`WITHINGS_CLIENT_ID`, `WITHINGS_CLIENT_SECRET`, `WITHINGS_REDIRECT_URI`) are missing

**Token Lifetimes**:
- **MCP Access Token**: Valid for 30 days (returned to Claude Desktop with `expires_in: 2592000`)
- **Withings Access Token**: Valid for ~3 hours (automatically refreshed transparently by the server)
- **Withings Refresh Token**: Used to obtain new Withings access tokens when they expire
- The MCP client (Claude Desktop) only needs to re-authenticate every 30 days, while Withings tokens are refreshed automatically in the background during API calls

### MCP Transport Layer

The server uses the SDK's **`WebStandardStreamableHTTPServerTransport`** (Streamable HTTP) for MCP communication:

- **Endpoint**: `/mcp` handles all HTTP methods via a single `handleMcp` handler (src/server/mcp-endpoints.ts)
- **POST /mcp** (no session): Initializes a new session — creates a `WebStandardStreamableHTTPServerTransport` and per-session `McpServer`, returns SSE stream with `Mcp-Session-Id` header
- **POST /mcp** (with session): Forwards JSON-RPC messages to the session's transport
- **GET /mcp**: Establishes SSE stream for server-to-client messages on an existing session
- **DELETE /mcp**: Terminates the session and cleans up resources
- **Authentication**: Bearer token (MCP access token) required in `Authorization` header
- **Routing**: `app.all(MCP_ENDPOINT, authenticateBearer, handleMcp)` in src/server/app.ts

**Session Management** (src/server/mcp-endpoints.ts):
- Sessions tracked in an in-memory `Map<string, { transport, mcpToken }>` keyed by session ID
- Session IDs generated by the SDK via `sessionIdGenerator: () => crypto.randomUUID()`
- Sessions are bound to the bearer token that created them; all requests verify token ownership (returns 403 on mismatch)
- `onsessioninitialized` callback registers the session in the Map
- `onsessionclosed` callback (triggered by DELETE) removes the session from the Map
- SSE streaming, JSON-RPC validation, and protocol handling are all managed by the SDK transport internally
- Request body size is limited to 1MB globally via Hono `bodyLimit()` middleware

### Data Storage

Uses **Supabase PostgreSQL** (@supabase/supabase-js) for persistent storage:

**Database Schema** (supabase/migrations/001_initial_schema.sql):
- `mcp_tokens`: MCP token → Withings token mapping (30 day TTL)
- `oauth_sessions`: OAuth session state (10 min TTL)
- `auth_codes`: Authorization codes (10 min TTL)
- `registered_clients`: Dynamic client registration (no TTL)
- `rate_limits`: Rate limiting counters (dynamic window TTL)
- `check_rate_limit()`: Atomic PostgreSQL function for race-condition-free rate limiting (uses `SELECT ... FOR UPDATE`)

**Token Store** (src/auth/token-store.ts):
- Maps MCP tokens → Withings tokens (access, refresh, userId, expiry)
- **Security**: Withings tokens encrypted at rest using AES-256-GCM (src/utils/encryption.ts)
- Encryption key derived from `ENCRYPTION_SECRET` via PBKDF2
- **TTL**: 30 days - enforced via `expires_at` column + query filtering
- **Token Refresh**: Withings access tokens (~3 hour lifetime) are automatically refreshed when expired/expiring during API calls (src/withings/api.ts)

**OAuth Store** (src/auth/oauth.ts):
- OAuth sessions (10min TTL): `oauth_sessions` table
- Auth codes (10min TTL): `auth_codes` table (Withings code encrypted at rest)
- Auth codes are consumed atomically via `consumeAuthCode()` (DELETE + SELECT in one query) to prevent replay
- Registered clients (no TTL): `registered_clients` table

**TTL Implementation**:
- All queries filter by `expires_at > now()` to exclude expired records
- Cleanup scheduler runs on startup and periodically:
  - Every 5 minutes: oauth_sessions, auth_codes, rate_limits
  - Every 1 hour: mcp_tokens
- Cleanup logic in src/db/cleanup.ts

## Environment Variables

Required:
- `WITHINGS_CLIENT_ID`: From Withings developer console
- `WITHINGS_CLIENT_SECRET`: From Withings developer console
- `WITHINGS_REDIRECT_URI`: Callback URL (must match Withings app settings)
- `ENCRYPTION_SECRET`: Secret key for encrypting tokens at rest (min 32 chars, generate with `npm run generate-secret` or `openssl rand -hex 32`)
- `SUPABASE_URL`: Supabase project URL (from Dashboard → Settings → API)
- `SUPABASE_SECRET_KEY`: Supabase service role key (from Dashboard → Settings → API)

Optional:
- `PORT`: Server port (default: 3000)
- `LOG_LEVEL`: Logging level - trace, debug, info, warn, error (default: info)
- `ALLOWED_ORIGINS`: Comma-separated list of allowed CORS origins for browser-based clients

See `.env.example` for template.

## MCP Tools

The server implements 12 MCP tools for accessing Withings health data, organized by Withings API category. All tools are registered via `registerAllTools()` (src/tools/index.ts) on per-session `McpServer` instances to ensure proper session isolation.

**Date Parameters:** All tools that accept date parameters use YYYY-MM-DD format (e.g., "2025-11-17"). The server automatically converts these to Unix timestamps before calling the Withings API.

### Sleep Tools (src/tools/sleep.ts)

#### get_sleep

Retrieves high-frequency sleep data captured during sleep, including sleep stages and health metrics at minute-level resolution.

**Parameters:**
- `startdate`: Start date (YYYY-MM-DD format, e.g., '2025-11-17')
- `enddate`: End date (YYYY-MM-DD format, max 24h range from startdate)
- `data_fields`: Optional comma-separated list of specific fields

**Note:** If startdate and enddate are separated by more than 24h, only the first 24h after startdate will be returned.

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
- `startdate`: Start date (YYYY-MM-DD format, e.g., '2025-11-01')
- `enddate`: End date (YYYY-MM-DD format, e.g., '2025-11-30')
- `lastupdate`: Unix timestamp for sync (alternative to date range)
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

**Response transformation:** The `category` field (workout type) and `model` field (device name) are replaced with human-readable descriptions instead of numeric IDs. For example, category `36` becomes `"Other"` and model `59` becomes `"Activite Steel HR Sport Edition"`.

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
- `startdate`: Start date (YYYY-MM-DD format, e.g., '2025-11-17', optional)
- `enddate`: End date (YYYY-MM-DD format, optional, max 24h from startdate)
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
- `startdate`: Start date (YYYY-MM-DD format, e.g., '2025-11-01', optional)
- `enddate`: End date (YYYY-MM-DD format, e.g., '2025-11-30', optional)
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
- `startdate`: Start date (YYYY-MM-DD format, e.g., '2025-11-01', optional)
- `enddate`: End date (YYYY-MM-DD format, e.g., '2025-11-30', optional)
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
- Sleep API (high-frequency sleep data, sleep summary data)
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

Each initialization request creates a **separate McpServer instance** and its own `WebStandardStreamableHTTPServerTransport` (src/server/mcp-endpoints.ts). This ensures tools and state are isolated per session. Tools are registered per-session via `registerAllTools()` from src/tools/index.ts. Sessions are bound to the bearer token used at creation, preventing cross-user session access.

### HTTP Security

- **HTTPS redirect**: Production requests via `x-forwarded-proto: http` are redirected to HTTPS (localhost excluded)
- **Body size limit**: 1MB global limit via Hono `bodyLimit()` middleware
- **CORS**: No `Access-Control-Allow-Origin` header for requests without an Origin header; only localhost and configured origins are allowed
- **CSP**: External stylesheets with `style-src 'self'` (no `unsafe-inline`)
- **Security headers**: HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy, Permissions-Policy

### Transport Lifecycle

- On initialization POST: transport + McpServer created, `server.connect(transport)` called, then `transport.handleRequest()` processes the request
- On subsequent requests: looked up from session Map and forwarded via `transport.handleRequest()`
- Session cleanup via `onsessionclosed` callback (triggered by DELETE requests)

### Tool Registration

Tools are registered using a centralized approach:
- Each tool category has its own file in `src/tools/`
- `src/tools/index.ts` provides `registerAllTools()` to register all tools at once
- Tools receive the `mcpAccessToken` as a closure parameter for authentication
- Each tool includes a human-friendly `title` (e.g., `get_sleep` → "Sleep Data")
- Each tool defines an `outputSchema` (Zod) describing the response structure, using `.passthrough()` on objects to allow dynamic API fields
- Each tool includes `annotations` (`readOnlyHint: true`, `destructiveHint: false`, `openWorldHint: true`) since all tools are read-only Withings API queries
- Tool handlers return both `structuredContent` (raw data object) and `content` (JSON-stringified text) for backward compatibility

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
- **Automatic Token Refresh**: Checks if Withings access token is expired or expiring within 5 minutes, and automatically refreshes it using the refresh token before making API calls
- Error handling for Withings API status codes (status !== 0)
- All requests use POST with `application/x-www-form-urlencoded` content type
