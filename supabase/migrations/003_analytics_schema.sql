-- Analytics table for tracking tool usage per user
-- TTL: 90 days for historical analysis

CREATE TABLE tool_analytics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  withings_user_id VARCHAR(255) NOT NULL,
  tool_name VARCHAR(100) NOT NULL,
  success BOOLEAN NOT NULL,
  duration_ms INTEGER NOT NULL,
  error_category VARCHAR(50),
  date_range_days INTEGER,
  mcp_session_id VARCHAR(255),
  invoked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes for common query patterns
CREATE INDEX idx_tool_analytics_user_id ON tool_analytics(withings_user_id);
CREATE INDEX idx_tool_analytics_tool_name ON tool_analytics(tool_name);
CREATE INDEX idx_tool_analytics_invoked_at ON tool_analytics(invoked_at);
CREATE INDEX idx_tool_analytics_expires_at ON tool_analytics(expires_at);
CREATE INDEX idx_tool_analytics_user_tool ON tool_analytics(withings_user_id, tool_name);

-- Enable Row Level Security (consistent with other tables)
ALTER TABLE tool_analytics ENABLE ROW LEVEL SECURITY;

-- Allow service role full access
CREATE POLICY "Service role has full access to tool_analytics"
  ON tool_analytics
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);
