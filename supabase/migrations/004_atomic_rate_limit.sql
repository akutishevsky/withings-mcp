-- Atomic rate limit check-and-increment function
-- Prevents race conditions by using a single transaction
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_identifier VARCHAR(512),
  p_max_requests INTEGER,
  p_window_ms BIGINT
)
RETURNS TABLE(allowed BOOLEAN, request_count INTEGER, reset_time TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now TIMESTAMPTZ := NOW();
  v_reset_time TIMESTAMPTZ;
  v_count INTEGER;
BEGIN
  -- Try to get the current record and lock it
  SELECT rl.request_count, rl.reset_time
  INTO v_count, v_reset_time
  FROM rate_limits rl
  WHERE rl.identifier = p_identifier
  FOR UPDATE;

  IF NOT FOUND OR v_reset_time < v_now THEN
    -- New window: upsert with count=1
    v_reset_time := v_now + (p_window_ms || ' milliseconds')::INTERVAL;
    INSERT INTO rate_limits (identifier, request_count, reset_time, updated_at)
    VALUES (p_identifier, 1, v_reset_time, v_now)
    ON CONFLICT (identifier) DO UPDATE
    SET request_count = 1, reset_time = v_reset_time, updated_at = v_now;

    RETURN QUERY SELECT TRUE, 1, v_reset_time;
  ELSIF v_count >= p_max_requests THEN
    -- Rate limit exceeded
    RETURN QUERY SELECT FALSE, v_count, v_reset_time;
  ELSE
    -- Increment count
    UPDATE rate_limits rl
    SET request_count = rl.request_count + 1, updated_at = v_now
    WHERE rl.identifier = p_identifier;

    RETURN QUERY SELECT TRUE, v_count + 1, v_reset_time;
  END IF;
END;
$$;
