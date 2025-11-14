# Withings MCP Server

MCP server for integrating Withings health data with Claude. This server uses OAuth 2.0 for secure authentication with Withings API and can be deployed to Deno Deploy.

## Prerequisites

1. Create a Withings developer account at https://developer.withings.com/
2. Create an application to get your client ID and secret
3. Note your redirect URI (this will be your deployed URL + `/auth/callback`)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

3. Generate encryption secret:
```bash
npm run generate-secret
# Copy the output and add it to your .env file or export it
```

4. Set environment variables:
```bash
export WITHINGS_CLIENT_ID="your_client_id"
export WITHINGS_CLIENT_SECRET="your_client_secret"
export WITHINGS_REDIRECT_URI="https://your-app.deno.dev/auth/callback"
export ENCRYPTION_SECRET="your_generated_secret_here"  # Required: from step 3
export PORT=3000
export LOG_LEVEL=info  # Optional: trace, debug, info, warn, error
export ALLOWED_ORIGINS="https://example.com,https://app.example.com"  # Optional: comma-separated list of allowed browser origins
```

## Deployment to Deno Deploy

1. Build the project:
```bash
npm run build
```

2. Deploy to production:
```bash
deno deploy --prod
```

3. Set environment variables:
```bash
# Generate encryption secret first
npm run generate-secret
# Copy the output value (without 'ENCRYPTION_SECRET=') and use it below

deno deploy env add WITHINGS_CLIENT_ID "your_client_id"
deno deploy env add WITHINGS_CLIENT_SECRET "your_client_secret"
deno deploy env add WITHINGS_REDIRECT_URI "https://your-app.deno.dev/auth/callback"
deno deploy env add ENCRYPTION_SECRET "paste_generated_secret_here"  # Required
deno deploy env add ALLOWED_ORIGINS "https://example.com,https://app.example.com"  # Optional
```

4. Update your Withings app settings with the callback URL from Deno Deploy

## OAuth Flow

1. Users navigate to `https://your-app.deno.dev/auth/authorize`
2. They are redirected to Withings to authorize
3. After authorization, they are redirected back with an MCP token
4. This token is used to authenticate MCP tool calls

## MCP Connection with Claude Desktop

Configure Claude Desktop to connect to your server. Add this to your Claude Desktop config file:

**macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "withings": {
      "url": "https://your-app.deno.dev",
      "transport": {
        "type": "sse",
        "endpoint": "/mcp"
      },
      "auth": {
        "type": "oauth2",
        "discovery": "/.well-known/oauth-authorization-server"
      }
    }
  }
}
```

When you restart Claude Desktop, it will initiate the OAuth flow and open your browser for authorization.

## Local Development

Run the server locally:
```bash
npm start
```

The server will be available at `http://localhost:3000`

## Available Tools

### get_sleep_summary
Retrieves sleep summary data including sleep duration, sleep stages (light, deep, REM), heart rate metrics, breathing quality, and sleep score.

**Parameters:**
- `startdateymd`: Start date (YYYY-MM-DD format)
- `enddateymd`: End date (YYYY-MM-DD format)
- `lastupdate`: Unix timestamp for synchronization
- `data_fields`: Optional comma-separated list of specific fields

### get_measures
Retrieves health measures with automatic type descriptions and calculated values including weight, body composition, blood pressure, heart rate, temperature, and advanced metrics (VO2 max, vascular age, metabolic age, BMR).

**Parameters:**
- `meastype`: Single measure type ID
- `meastypes`: Comma-separated list of measure type IDs
- `startdate`/`enddate`: Unix timestamps for date range
- `lastupdate`: Unix timestamp for synchronization
- `offset`: Pagination offset

### get_workouts
Retrieves workout summaries with comprehensive metrics including calories burned, workout intensity, heart rate data, distance, steps, elevation, and swimming metrics.

**Parameters:**
- `startdateymd`: Start date (YYYY-MM-DD format)
- `enddateymd`: End date (YYYY-MM-DD format)
- `lastupdate`: Unix timestamp for synchronization
- `offset`: Pagination offset
- `data_fields`: Comma-separated list of fields (defaults to all fields)

## Security

### Token Encryption

All Withings access and refresh tokens are encrypted at rest using **AES-256-GCM** before being stored in Deno KV:

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Derivation**: PBKDF2 with 100,000 iterations
- **Encryption Key**: Derived from `ENCRYPTION_SECRET` environment variable
- **Defense in Depth**: Even if the database is compromised, tokens remain protected

**Important**: The `ENCRYPTION_SECRET` must be:
- At least 32 characters long
- Randomly generated (use `npm run generate-secret` or `openssl rand -hex 32`)
- Kept secure and never committed to version control
- Consistent across server restarts (store securely)

### Logging

This server uses a custom logger with strict privacy controls:
- **No sensitive data logged**: All tokens, credentials, user IDs, and personal information are automatically redacted
- **Production ready**: Suitable for public repositories with privacy-first design
- **Configurable**: Set `LOG_LEVEL` environment variable (trace, debug, info, warn, error)

All logging is minimal and focused on operational events and debugging, never exposing confidential or user-related information.

## License

MIT
