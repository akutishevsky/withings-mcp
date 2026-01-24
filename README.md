# Withings MCP Server

A Model Context Protocol (MCP) server that brings your Withings health data into Claude. Access your sleep patterns, body measurements, workouts, heart data, and more through natural conversation.

**🔒 Privacy First**: This is my personal project, and the repository is intentionally public to demonstrate transparency. The code shows that **no personal information is logged or stored maliciously**. All sensitive data (tokens, user IDs) is encrypted at rest and automatically redacted from logs. You can review the entire codebase to verify this commitment to privacy.

**⚠️ Disclaimer**: This server is provided **as-is** without any guarantees or warranties. While I've made every effort to ensure security and privacy, I make no guarantees about availability, data integrity, or security. Use at your own risk. For production use cases, consider self-hosting your own instance.

## Table of Contents

- [What Can You Do With This?](#what-can-you-do-with-this)
- [For End Users: Using the Hosted Server](#for-end-users-using-the-hosted-server)
  - [Prerequisites](#prerequisites)
  - [Setup Instructions](#setup-instructions)
  - [Available Tools](#available-tools)
  - [Example Conversations](#example-conversations)
  - [Privacy & Security](#privacy--security)
- [For Developers: Self-Hosting](#for-developers-self-hosting)
  - [Prerequisites](#prerequisites-1)
  - [Step 1: Create Withings Application](#step-1-create-withings-application)
  - [Step 2: Clone and Setup](#step-2-clone-and-setup)
  - [Step 3: Local Development](#step-3-local-development)
  - [Step 4: Deploy to Production](#step-4-deploy-to-production)
  - [Step 5: Update Withings App Settings](#step-5-update-withings-app-settings)
  - [Step 6: Configure Your MCP Client](#step-6-configure-your-mcp-client)
  - [Environment Variables Reference](#environment-variables-reference)
  - [Development Commands](#development-commands)
  - [Project Structure](#project-structure)
- [Security Features](#security-features)
  - [Token Encryption](#token-encryption)
  - [Privacy-Safe Logging](#privacy-safe-logging)
- [Contributing](#contributing)
- [License](#license)
- [Support](#support)
- [Acknowledgments](#acknowledgments)

## What Can You Do With This?

This MCP server gives Claude access to your Withings health data, allowing you to:

- **Analyze your sleep**: Ask about sleep quality, duration, deep sleep stages, heart rate during sleep
- **Track body metrics**: Weight trends, body composition, blood pressure, heart rate over time
- **Review workouts**: Analyze exercise patterns, calories burned, heart rate zones
- **Monitor heart health**: Access ECG recordings and detailed heart data
- **Set and track goals**: Review your fitness and health goals
- **Identify patterns**: Find correlations between sleep, activity, and other metrics
- **Generate insights**: Get AI-powered analysis of your health trends

All through natural conversation with Claude or any other MCP-compatible client.

## For End Users: Using the Hosted Server

If you just want to use this MCP server with Claude Desktop without hosting anything yourself, follow these steps:

### Prerequisites

1. A [Withings account](https://www.withings.com/) with connected devices
2. [Claude Desktop](https://claude.ai/download) or any other MCP-compatible client installed on your computer

### Setup Instructions

#### Step 1: Add Connector in Claude Desktop

1. Open Claude Desktop
2. Go to **Settings** (gear icon in the bottom-left corner)
3. Navigate to the **Connectors** tab
4. Click **Add Custom Connector**
5. Fill in the following details:
   - **Name**: `Withings` (or any name you prefer)
   - **Remote MCP server URL**: `https://withings-mcp.com/mcp`
6. Click **Add**

> **Note**: If your MCP client doesn't support UI-based connector configuration, you can manually edit the config file instead. See the [manual configuration guide](#manual-configuration) below.

#### Step 2: Connect and Authorize

1. In the **Connectors** settings, find the Withings connector you just added
2. Click **Connect** next to the connector
3. Your web browser will open with the Withings authorization page
4. Log in to your Withings account
5. Review and approve the permissions requested
6. You'll be redirected back and the connection will be complete

After authorization, Claude will have access to your Withings data!

### Available Tools

Once connected, Claude can use these tools to access your data:

#### Sleep & Activity
- `get_sleep_summary` - Sleep duration, stages (light/deep/REM), heart rate, breathing, sleep score
- `get_activity` - Daily steps, distance, calories, elevation, activity durations
- `get_intraday_activity` - High-frequency activity data throughout the day
- `get_workouts` - Detailed workout summaries with heart rate zones and metrics

#### Body Measurements
- `get_measures` - Weight, body composition, blood pressure, heart rate, temperature, VO2 max, and more

#### Devices & Goals
- `get_user_devices` - List of connected Withings devices
- `get_user_goals` - Your health and fitness goals (steps, sleep, weight)

#### Heart Health
- `list_heart_records` - List of ECG recordings
- `get_heart_signal` - Detailed ECG waveform data

#### Stethoscope (if you have BPM Core)
- `list_stetho_records` - List of stethoscope recordings
- `get_stetho_signal` - Detailed audio signal data

### Example Conversations

Try asking Claude:

- "How has my sleep quality been over the past week?"
- "Show me my weight trend for the last month"
- "What's my average resting heart rate?"
- "Did I hit my step goal this week?"
- "Compare my workout intensity between this month and last month"
- "When did I sleep best this month?"

### Privacy & Security

- **Encrypted tokens**: All authentication tokens are encrypted using AES-256-GCM before storage
- **No logging of personal data**: The code is public - you can verify that no sensitive information is logged
- **Automatic redaction**: All user IDs, tokens, and credentials are automatically redacted from system logs
- **OAuth 2.0**: Industry-standard secure authentication with Withings
- **You're in control**: Revoke access anytime from your Withings account settings

---

## For Developers: Self-Hosting

Want to run your own instance? Here's how to deploy this MCP server yourself.

### Prerequisites

1. [Node.js](https://nodejs.org/) 18+ and npm installed
2. [Deno CLI](https://deno.land/) installed for deployment
3. A [Withings Developer Account](https://developer.withings.com/)

### Step 1: Create Withings Application

1. Go to [Withings Developer Portal](https://developer.withings.com/)
2. Create a new application
3. Note your **Client ID** and **Client Secret**
4. Set your **Redirect URI** to: `https://your-domain.com/callback`
   - This must be a publicly accessible URL (localhost is not supported by Withings)
   - Can be any domain where you'll host the server (e.g., Deno Deploy, your own server, etc.)

### Step 2: Clone and Setup

```bash
# Clone the repository
git clone https://github.com/your-username/withings-mcp.git
cd withings-mcp

# Install dependencies
npm install

# Generate encryption secret
npm run generate-secret
# Copy the output - you'll need it for environment variables
```

### Step 2.5: Set Up Supabase Database

1. Create a free project at [Supabase](https://supabase.com)
2. Install the Supabase CLI: `npm install -g supabase`
3. Link your project: `supabase link --project-ref <your-project-ref>`
4. Apply the database migrations: `supabase db push`
5. Get your credentials from Dashboard → Settings → API:
   - **Project URL** → `SUPABASE_URL`
   - **Service role key** → `SUPABASE_SECRET_KEY`

### Step 3: Local Development

> **Note**: Withings requires a publicly accessible URL for OAuth callbacks. For local development, use a tunneling service to expose your local server or deploy to a staging environment for testing.

```bash
# Copy environment template
cp .env.example .env

# Edit .env with your values
# WITHINGS_CLIENT_ID=your_client_id
# WITHINGS_CLIENT_SECRET=your_client_secret
# WITHINGS_REDIRECT_URI=https://your-tunnel-url.com/callback
# ENCRYPTION_SECRET=paste_generated_secret_here
# SUPABASE_URL=https://your-project.supabase.co
# SUPABASE_SECRET_KEY=your_service_role_key
# PORT=3000

# Build the project
npm run build

# Run locally
npm start
```

Make sure your redirect URI in the .env file matches the publicly accessible URL pointing to your local server.

### Step 4: Deploy to Production

```bash
# Build the project
npm run build

# Deploy to your hosting platform of choice
# The build output is in the ./build directory
```

Set the following environment variables on your hosting platform:

| Variable | Required | Example |
|----------|----------|---------|
| `WITHINGS_CLIENT_ID` | Yes | `your_client_id` |
| `WITHINGS_CLIENT_SECRET` | Yes | `your_client_secret` |
| `WITHINGS_REDIRECT_URI` | Yes | `https://your-domain.com/callback` |
| `ENCRYPTION_SECRET` | Yes | Generated from step 2 |
| `SUPABASE_URL` | Yes | `https://your-project.supabase.co` |
| `SUPABASE_SECRET_KEY` | Yes | Your Supabase service role key |
| `PORT` | No | `3000` (or your platform's default) |
| `LOG_LEVEL` | No | `info` |
| `ALLOWED_ORIGINS` | No | `https://example.com,https://app.example.com` |

### Step 5: Update Withings App Settings

Go back to your Withings developer app and update the redirect URI to match your deployed URL:
`https://your-domain.com/callback`

### Step 6: Configure Your MCP Client

#### For Claude Desktop:

1. Open Claude Desktop
2. Go to **Settings** → **Connectors** tab
3. Click **Add Custom Connector**
4. Fill in the following details:
   - **Name**: `Withings` (or any name you prefer)
   - **Remote MCP server URL**: `https://your-domain.com/mcp`
5. Click **Add**
6. Click **Connect** next to the connector to authorize

#### For Other MCP Clients:

Configure your MCP client with the following connection details:
- **Server URL**: `https://your-domain.com`
- **Transport**: Server-Sent Events (SSE)
- **Endpoint**: `/mcp`
- **Authentication**: OAuth 2.0
- **Discovery URL**: `/.well-known/oauth-authorization-server`

### Environment Variables Reference

| Variable | Required | Description |
|----------|----------|-------------|
| `WITHINGS_CLIENT_ID` | Yes | Your Withings app client ID |
| `WITHINGS_CLIENT_SECRET` | Yes | Your Withings app client secret |
| `WITHINGS_REDIRECT_URI` | Yes | OAuth callback URL (must match Withings app settings) |
| `ENCRYPTION_SECRET` | Yes | 32+ character secret for token encryption (generate with `npm run generate-secret`) |
| `SUPABASE_URL` | Yes | Your Supabase project URL (from Dashboard → Settings → API) |
| `SUPABASE_SECRET_KEY` | Yes | Your Supabase service role key (from Dashboard → Settings → API) |
| `PORT` | No | Server port (default: 3000) |
| `LOG_LEVEL` | No | Logging level: trace, debug, info, warn, error (default: info) |
| `ALLOWED_ORIGINS` | No | Comma-separated list of allowed CORS origins for browser clients |

### Development Commands

```bash
npm run build            # Compile TypeScript to JavaScript
npm run dev              # Watch mode - recompile on changes
npm run generate-secret  # Generate encryption secret for ENCRYPTION_SECRET env variable
```

### Project Structure

```
src/
├── auth/              # OAuth 2.0 authentication & token storage
├── db/                # Supabase client & cleanup scheduler
├── server/            # Hono app, MCP endpoints, middleware
├── tools/             # MCP tools for Withings API (sleep, measure, user, heart, stetho)
├── transport/         # Custom SSE transport for MCP
├── withings/          # Withings API client
├── utils/             # Logger and encryption utilities
└── index.ts           # Main entry point

supabase/
└── migrations/        # Database schema migrations
```

See [CLAUDE.md](CLAUDE.md) for detailed architecture documentation.

## Security Features

### Token Encryption

All Withings access and refresh tokens are encrypted at rest using **AES-256-GCM**:

- **Algorithm**: AES-256-GCM (authenticated encryption)
- **Key Derivation**: PBKDF2 with 100,000 iterations
- **Defense in Depth**: Even if the database is compromised, tokens remain protected

**Important**: Keep your `ENCRYPTION_SECRET`:
- At least 32 characters long
- Randomly generated (use `npm run generate-secret`)
- Secure and never committed to version control
- Consistent across server restarts

### Privacy-Safe Logging

The custom logger automatically redacts all sensitive information:
- ✅ Operational events and errors logged
- ❌ No tokens, credentials, or auth codes
- ❌ No user IDs or personal information
- ❌ No API request/response payloads with sensitive data

You can review the logging implementation in `src/utils/logger.ts`.

## Contributing

This is a personal project, but contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see [LICENSE](LICENSE) file for details.

## Support

- **Issues**: Report bugs or request features on [GitHub Issues](https://github.com/your-username/withings-mcp/issues)
- **Withings API**: See [Withings API Documentation](https://developer.withings.com/api-reference)
- **MCP Protocol**: See [Model Context Protocol Documentation](https://modelcontextprotocol.io/)

## Acknowledgments

Built with:
- [Model Context Protocol](https://modelcontextprotocol.io/) by Anthropic
- [Withings API](https://developer.withings.com/)
- [Hono](https://hono.dev/) web framework
- [Supabase](https://supabase.com/) for database
- [Deno Deploy](https://deno.com/deploy) for hosting
