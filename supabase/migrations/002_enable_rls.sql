-- Enable Row Level Security on all tables
-- Service role key bypasses RLS, so this only blocks anon key access

ALTER TABLE mcp_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE registered_clients ENABLE ROW LEVEL SECURITY;
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- No policies = deny all for anon/authenticated users
-- Service role key still has full access (bypasses RLS)
