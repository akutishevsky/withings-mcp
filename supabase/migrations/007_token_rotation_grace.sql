-- Rotation grace window for MCP tokens.
--
-- The refresh_token grant rotated with a bare UPDATE ... WHERE mcp_token = old,
-- so a retried or concurrent refresh matched no row and received a terminal
-- invalid_grant — permanently stranding a client whose first response was lost.
-- Keeping the previous token resolvable for a short window makes refresh
-- idempotent: a retry is handed the same token the winning request was issued.
--
-- Grace is deliberately short (60s in src/auth/token-store.ts). It only needs to
-- cover a client's immediate retry, not a second refresh cycle.

ALTER TABLE mcp_tokens
  ADD COLUMN previous_mcp_token VARCHAR(255),
  ADD COLUMN previous_token_expires_at TIMESTAMPTZ;

-- Lookup path for resolving a presented token that was just rotated away
CREATE INDEX idx_mcp_tokens_previous_mcp_token ON mcp_tokens(previous_mcp_token);
