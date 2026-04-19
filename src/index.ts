#!/usr/bin/env bun

import { initSupabase } from "./db/supabase.js";
import { initOAuthStore } from "./auth/oauth.js";
import { tokenStore } from "./auth/token-store.js";
import { createApp } from "./server/app.js";
import { setOAuthConfig } from "./config.js";
import { initRateLimiter } from "./server/rate-limiter.js";
import process from "node:process";

// Initialize Supabase first (required by all stores).
// Expired-record cleanup is handled by pg_cron in the database
// (see supabase/migrations/005_pg_cron_cleanup.sql).
await initSupabase();

// Initialize stores (now use Supabase internally)
await tokenStore.init();
await initOAuthStore();
await initRateLimiter();

// Validate required environment variables at startup
const requiredEnvVars = [
  "WITHINGS_CLIENT_ID",
  "WITHINGS_CLIENT_SECRET",
  "WITHINGS_REDIRECT_URI",
] as const;

for (const envVar of requiredEnvVars) {
  if (!process.env[envVar]) {
    throw new Error(`Missing required environment variable: ${envVar}`);
  }
}

// OAuth configuration from environment
const oauthConfig = {
  clientId: process.env.WITHINGS_CLIENT_ID!,
  clientSecret: process.env.WITHINGS_CLIENT_SECRET!,
  redirectUri: process.env.WITHINGS_REDIRECT_URI!,
};

// Set global OAuth config
setOAuthConfig(oauthConfig);

// Create and configure the app
const app = createApp({ oauthConfig });

const port = Number.parseInt(process.env.PORT ?? "8080", 10);

// Bun picks up the default export and starts the HTTP server automatically
export default {
  fetch: app.fetch,
  port,
};
