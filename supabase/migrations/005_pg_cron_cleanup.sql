-- Schedule cleanup of expired records via pg_cron.
-- Replaces in-process setInterval timers on the Deno Deploy side so
-- isolates can be recycled during idle periods (reduces Memory Time).

CREATE EXTENSION IF NOT EXISTS pg_cron;

-- Short-lived records: every 5 minutes
SELECT cron.schedule(
  'cleanup-short-lived',
  '*/5 * * * *',
  $$
    DELETE FROM oauth_sessions WHERE expires_at < NOW();
    DELETE FROM auth_codes WHERE expires_at < NOW();
    DELETE FROM rate_limits WHERE reset_time < NOW();
  $$
);

-- MCP tokens: hourly
SELECT cron.schedule(
  'cleanup-mcp-tokens',
  '0 * * * *',
  $$ DELETE FROM mcp_tokens WHERE expires_at < NOW() $$
);

-- Tool analytics: daily at 03:00 UTC
SELECT cron.schedule(
  'cleanup-tool-analytics',
  '0 3 * * *',
  $$ DELETE FROM tool_analytics WHERE expires_at < NOW() $$
);
