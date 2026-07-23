-- MCP session registry: session_id -> owning MCP token
-- TTL: 30 days (matches mcp_tokens; a session can never outlive its bearer token)
--
-- The transport object itself cannot be serialized, but everything a session
-- actually needs is the token it is bound to — tools re-read all Withings
-- credentials from mcp_tokens on every call. Persisting that mapping lets a
-- restarted (or second) instance rebuild a session instead of returning 404,
-- which MCP clients do not recover from in practice.

CREATE TABLE mcp_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id VARCHAR(255) UNIQUE NOT NULL,
  mcp_token VARCHAR(255) NOT NULL,
  last_activity_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_mcp_sessions_session_id ON mcp_sessions(session_id);
CREATE INDEX idx_mcp_sessions_mcp_token ON mcp_sessions(mcp_token);
CREATE INDEX idx_mcp_sessions_expires_at ON mcp_sessions(expires_at);

-- Enable Row Level Security (consistent with other tables)
ALTER TABLE mcp_sessions ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role has full access to mcp_sessions"
  ON mcp_sessions
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- Expired sessions: hourly, same cadence as the mcp_tokens they depend on
SELECT cron.schedule(
  'cleanup-mcp-sessions',
  '30 * * * *',
  $$ DELETE FROM mcp_sessions WHERE expires_at < NOW() $$
);
