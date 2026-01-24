#!/usr/bin/env node

import { initSupabase } from "./db/supabase.js";
import { cleanupExpiredRecords, scheduleCleanup } from "./db/cleanup.js";
import { initOAuthStore } from "./auth/oauth.js";
import { tokenStore } from "./auth/token-store.js";
import { createApp } from "./server/app.js";
import { setOAuthConfig } from "./config.js";
import { initRateLimiter } from "./server/rate-limiter.js";

// Initialize Supabase first (required by all stores)
await initSupabase();

// Cleanup expired records immediately, then schedule periodic cleanup
await cleanupExpiredRecords();
scheduleCleanup();

// Initialize stores (now use Supabase internally)
await tokenStore.init();
await initOAuthStore();
await initRateLimiter();

// OAuth configuration from environment
const oauthConfig = {
  clientId: process.env.WITHINGS_CLIENT_ID || "",
  clientSecret: process.env.WITHINGS_CLIENT_SECRET || "",
  redirectUri: process.env.WITHINGS_REDIRECT_URI || "http://localhost:3000/callback",
};

// Set global OAuth config
setOAuthConfig(oauthConfig);

// Create and configure the app
const app = createApp({ oauthConfig });

// Export for Deno Deploy
export default {
  fetch: app.fetch,
};
