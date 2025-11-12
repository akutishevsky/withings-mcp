# Withings MCP Server

MCP server for integrating Withings health data with Claude.

## Setup

1. Install dependencies:
```bash
npm install
```

2. Build the project:
```bash
npm run build
```

3. Configure your Withings API credentials (see Configuration section below)

## Configuration

This server requires a Withings API access token. You'll need to:

1. Create a Withings developer account at https://developer.withings.com/
2. Create an application to get your client ID and secret
3. Obtain an access token through OAuth flow
4. Set the `WITHINGS_ACCESS_TOKEN` environment variable

## Usage

Run the server:
```bash
npm start
```

Or for development with auto-rebuild:
```bash
npm run dev
```

## Available Tools

(Tools will be added as the server is developed)

## License

MIT
