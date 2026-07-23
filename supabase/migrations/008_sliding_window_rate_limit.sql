-- Sliding-window rate limiting (weighted two-window counter).
--
-- The fixed-window implementation in 004 only reset at a hard boundary, so a
-- client that burned its budget in the first seconds of a window stayed locked
-- out for the entire remainder of it. On /token that meant up to ~59 minutes,
-- long enough that a user whose refresh grant had died could not re-authorize.
--
-- This keeps two counters per identifier — the current window and the one
-- before it — and estimates the trailing-window rate by weighting the previous
-- count by how much of it still falls inside the trailing window:
--
--   estimate = previous_count * (time_left_in_current_window / window) + current_count
--
-- Capacity therefore returns continuously as the previous window ages out
-- rather than all at once at a boundary, and storage stays at one row per
-- identifier (a true sliding log would need a timestamp per request).
--
-- NOTE: this smoothing lengthens the worst-case tail — a fully-burned window
-- takes up to TWO window lengths to decay completely, versus one for a fixed
-- window. It is only an improvement if the window is short. The callers in
-- src/auth/oauth.ts were moved to 5-minute windows accordingly; do not raise
-- them back to an hour without revisiting this.

ALTER TABLE rate_limits
  ADD COLUMN previous_count INTEGER NOT NULL DEFAULT 0;

-- Signature is unchanged so src/server/rate-limiter.ts needs no rewrite.
-- `request_count` returns the ceiling of the weighted estimate (so
-- X-RateLimit-Remaining stays meaningful) and, on the denied path,
-- `reset_time` returns the moment capacity actually becomes available rather
-- than the raw window boundary — an honest Retry-After was the whole point.
CREATE OR REPLACE FUNCTION check_rate_limit(
  p_identifier VARCHAR(512),
  p_max_requests INTEGER,
  p_window_ms BIGINT
)
RETURNS TABLE(allowed BOOLEAN, request_count INTEGER, reset_time TIMESTAMPTZ)
LANGUAGE plpgsql
AS $$
DECLARE
  v_now        TIMESTAMPTZ := NOW();
  v_window     INTERVAL := (p_window_ms || ' milliseconds')::INTERVAL;
  v_reset_time TIMESTAMPTZ;
  v_current    INTEGER;
  v_previous   INTEGER;
  v_weight     NUMERIC;
  v_estimate   NUMERIC;
  v_retry_at   TIMESTAMPTZ;
BEGIN
  SELECT rl.request_count, rl.previous_count, rl.reset_time
  INTO v_current, v_previous, v_reset_time
  FROM rate_limits rl
  WHERE rl.identifier = p_identifier
  FOR UPDATE;

  IF NOT FOUND THEN
    v_reset_time := v_now + v_window;
    INSERT INTO rate_limits (identifier, request_count, previous_count, reset_time, updated_at)
    VALUES (p_identifier, 1, 0, v_reset_time, v_now)
    ON CONFLICT (identifier) DO UPDATE
    SET request_count = 1, previous_count = 0, reset_time = v_reset_time, updated_at = v_now;

    RETURN QUERY SELECT TRUE, 1, v_reset_time;
    RETURN;
  END IF;

  -- Roll the windows forward if the stored one has ended.
  IF v_now >= v_reset_time THEN
    IF v_now < v_reset_time + v_window THEN
      -- Exactly one window elapsed: the current count becomes the previous one.
      v_previous := v_current;
      v_current := 0;
      v_reset_time := v_reset_time + v_window;
    ELSE
      -- More than one window elapsed: nothing left to carry.
      v_previous := 0;
      v_current := 0;
      v_reset_time := v_now + v_window;
    END IF;
  END IF;

  -- Fraction of the previous window still inside the trailing window.
  v_weight := LEAST(1.0, GREATEST(0.0,
    EXTRACT(EPOCH FROM (v_reset_time - v_now)) * 1000.0 / p_window_ms));
  v_estimate := (v_previous * v_weight) + v_current;

  IF v_estimate >= p_max_requests THEN
    -- Earliest moment the estimate drops below the limit. Solving
    --   previous * (reset - t)/window + current < max
    -- for t gives t > reset - window * (max - current)/previous.
    -- NB: interval only multiplies by double precision in Postgres — there is
    -- no interval * numeric operator — hence the explicit casts below.
    IF v_current >= p_max_requests THEN
      -- The current window alone is at the limit; it cannot decay until the
      -- window rolls, after which the same count decays as `previous`.
      v_retry_at := (v_reset_time + v_window)
                    - v_window * (p_max_requests::DOUBLE PRECISION
                                  / GREATEST(v_current, 1)::DOUBLE PRECISION);
      v_retry_at := GREATEST(v_retry_at, v_reset_time);
    ELSIF v_previous > 0 THEN
      v_retry_at := v_reset_time
                    - v_window * ((p_max_requests - v_current)::DOUBLE PRECISION
                                  / v_previous::DOUBLE PRECISION);
      v_retry_at := GREATEST(v_retry_at, v_now);
    ELSE
      v_retry_at := v_reset_time;
    END IF;

    -- Persist any window roll so the next call does not recompute it.
    UPDATE rate_limits rl
    SET request_count = v_current,
        previous_count = v_previous,
        reset_time = v_reset_time,
        updated_at = v_now
    WHERE rl.identifier = p_identifier;

    RETURN QUERY SELECT FALSE, CEIL(v_estimate)::INTEGER, v_retry_at;
    RETURN;
  END IF;

  v_current := v_current + 1;

  UPDATE rate_limits rl
  SET request_count = v_current,
      previous_count = v_previous,
      reset_time = v_reset_time,
      updated_at = v_now
  WHERE rl.identifier = p_identifier;

  RETURN QUERY SELECT TRUE, CEIL(v_estimate)::INTEGER + 1, v_reset_time;
END;
$$;
