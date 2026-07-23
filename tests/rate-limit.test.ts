/**
 * Tests for the `check_rate_limit` plpgsql function (migrations 004 -> 008 -> 009).
 *
 * `check_rate_limit` is a weighted two-window sliding counter:
 *
 *   estimate = previous_count * (time_left_in_window / window) + current_count
 *
 * Two real bugs shipped from this function, and most of what is below exists to
 * stop them coming back:
 *
 *   1. `interval * numeric` has no operator in Postgres (only
 *      `interval * double precision`). The retry-time arithmetic on the DENIED
 *      path hit it, so *every* denied request raised instead of returning 429.
 *      The allowed path never touches that code, so a happy-path-only test
 *      suite would have shipped it again.
 *   2. A row written under a LONGER window kept its distant `reset_time`, which
 *      pinned the decay weight at 1.0 forever: the window never rolled and
 *      Retry-After came back as ~43 minutes instead of ~8. Migration 009 clamps
 *      the stored boundary back into range.
 *
 * TECHNIQUE: the deployed function takes no clock parameter — it reads `NOW()`.
 * Rather than sleep (which would make a 5-minute-window suite untestable), every
 * test SEEDS the `rate_limits` row directly with a chosen
 * `(request_count, previous_count, reset_time)` to place the identifier at an
 * arbitrary point in its window, then calls `check_rate_limit` exactly once and
 * asserts on the returned `(allowed, request_count, reset_time)` plus the row
 * left behind.
 *
 * `reset_time` is always expressed relative to `now()` inside SQL. Note that
 * `now()` is transaction_timestamp(), so the `now()` in the outer SELECT is the
 * *same instant* as the `NOW()` the function reads — the returned offsets are
 * exact, not jittery. Seeding happens in an earlier transaction, so seeded
 * offsets drift by a few milliseconds; assertions are toleranced accordingly.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { createTestSchema, hasDatabase, type TestDb } from "./helpers/db.ts";

/** Production config for the OAuth endpoints: 30 requests per 5 minutes. */
const MAX = 30;
const WINDOW_MS = 300_000;
const WINDOW_S = WINDOW_MS / 1000;

interface CheckResult {
  allowed: boolean;
  /** Ceiling of the weighted estimate the function computed. */
  request_count: number;
  /** Seconds from the call instant until the returned reset_time. */
  reset_in_seconds: number;
}

interface StoredRow {
  request_count: number;
  previous_count: number;
  /** Seconds from read time until the persisted reset_time. */
  reset_in_seconds: number;
}

describe.skipIf(!hasDatabase)("check_rate_limit", () => {
  let db!: TestDb;

  beforeAll(async () => {
    db = await createTestSchema("rate_limit");
  });

  afterAll(async () => {
    await db?.drop();
  });

  /**
   * Call the function once. `reset_in_seconds` is computed in the same
   * statement (therefore the same transaction, therefore the same `now()`) so
   * it is an exact offset from the clock the function itself used.
   */
  async function check(
    identifier: string,
    maxRequests = MAX,
    windowMs = WINDOW_MS
  ): Promise<CheckResult> {
    const rows = await db.sql.unsafe(
      `SELECT allowed,
              request_count,
              EXTRACT(EPOCH FROM (reset_time - now()))::double precision AS reset_in_seconds
         FROM check_rate_limit($1::varchar, $2::integer, $3::bigint)`,
      [identifier, maxRequests, windowMs]
    );
    const row = rows[0];
    return {
      allowed: Boolean(row.allowed),
      request_count: Number(row.request_count),
      reset_in_seconds: Number(row.reset_in_seconds),
    };
  }

  /**
   * Place an identifier at an arbitrary point in its window. `resetOffsetSeconds`
   * is relative to now: positive = window still open, negative = window elapsed.
   */
  async function seed(
    identifier: string,
    current: number,
    previous: number,
    resetOffsetSeconds: number
  ): Promise<void> {
    await db.sql.unsafe(
      `INSERT INTO rate_limits (identifier, request_count, previous_count, reset_time, updated_at)
       VALUES ($1, $2, $3, now() + ($4::double precision * interval '1 second'), now())
       ON CONFLICT (identifier) DO UPDATE
          SET request_count  = EXCLUDED.request_count,
              previous_count = EXCLUDED.previous_count,
              reset_time     = EXCLUDED.reset_time,
              updated_at     = EXCLUDED.updated_at`,
      [identifier, current, previous, resetOffsetSeconds]
    );
  }

  /** Read back what the function persisted — the roll/clamp is only visible here. */
  async function readRow(identifier: string): Promise<StoredRow> {
    const rows = await db.sql.unsafe(
      `SELECT request_count,
              previous_count,
              EXTRACT(EPOCH FROM (reset_time - now()))::double precision AS reset_in_seconds
         FROM rate_limits
        WHERE identifier = $1`,
      [identifier]
    );
    const row = rows[0];
    return {
      request_count: Number(row.request_count),
      previous_count: Number(row.previous_count),
      reset_in_seconds: Number(row.reset_in_seconds),
    };
  }

  test("a fresh identifier is allowed and starts a window at count 1", async () => {
    const id = "fresh:identifier";

    const result = await check(id);

    expect(result.allowed).toBe(true);
    expect(result.request_count).toBe(1);
    // A brand new row must open a full window, not inherit anything.
    expect(result.reset_in_seconds).toBeGreaterThan(WINDOW_S - 5);
    expect(result.reset_in_seconds).toBeLessThanOrEqual(WINDOW_S + 1);

    const stored = await readRow(id);
    expect(stored.request_count).toBe(1);
    expect(stored.previous_count).toBe(0);
  });

  test("consecutive requests under the limit are allowed and increment the count", async () => {
    const id = "under:limit";

    // No seeding: three real calls in the same window. previous_count is 0, so
    // the weighted estimate is just the current count and the reported
    // request_count must track it exactly (X-RateLimit-Remaining depends on it).
    expect(await check(id)).toMatchObject({ allowed: true, request_count: 1 });
    expect(await check(id)).toMatchObject({ allowed: true, request_count: 2 });
    expect(await check(id)).toMatchObject({ allowed: true, request_count: 3 });

    const stored = await readRow(id);
    expect(stored.request_count).toBe(3);
    expect(stored.previous_count).toBe(0);
  });

  test("a request at the limit is denied", async () => {
    const id = "at:limit";
    // Half the window still to run, budget fully spent in the current window.
    await seed(id, MAX, 0, 150);

    const result = await check(id);

    expect(result.allowed).toBe(false);
    // estimate = 0 * 0.5 + 30 = 30, and the check is `>= p_max_requests`.
    expect(result.request_count).toBe(MAX);
  });

  test("the denied path returns a row instead of raising (bug 1: interval * numeric)", async () => {
    // REGRESSION TEST for bug 1. Only the denied path multiplies an interval by
    // a ratio, and `interval * numeric` has no operator in Postgres — the fix
    // was to cast both operands to DOUBLE PRECISION. If that cast is ever
    // dropped, these calls raise `operator does not exist: interval * numeric`
    // and every rate-limited request 500s instead of returning 429.
    //
    // There are TWO such expressions (one per denial branch), so both are
    // exercised here.

    // Branch A: v_current >= p_max_requests
    //   v_retry_at := (reset + window) - window * (max::float8 / current::float8)
    const currentBranch = "denied:current-branch";
    await seed(currentBranch, 45, 0, 120);
    const a = await check(currentBranch);
    expect(a).toBeDefined();
    expect(a.allowed).toBe(false);

    // Branch B: v_current < p_max_requests but v_previous > 0 carries it over
    //   v_retry_at := reset - window * ((max - current)::float8 / previous::float8)
    const previousBranch = "denied:previous-branch";
    await seed(previousBranch, 5, MAX, 299);
    const b = await check(previousBranch);
    expect(b).toBeDefined();
    expect(b.allowed).toBe(false);
    // estimate = 30 * (299/300) + 5 = 34.9 -> CEIL = 35
    expect(b.request_count).toBeGreaterThanOrEqual(34);
    expect(b.request_count).toBeLessThanOrEqual(35);
  });

  test("a denial returns a Retry-After in the future and within two windows", async () => {
    // src/server/rate-limiter.ts turns the returned reset_time straight into
    // Retry-After: `ceil((resetTime - Date.now()) / 1000)`. A past value would
    // emit a negative/zero Retry-After; a value beyond two windows is by
    // definition wrong, because a fully-burned window decays completely in at
    // most two window lengths under this algorithm.
    const cases: Array<[string, number, number, number]> = [
      // [identifier, current, previous, resetOffsetSeconds]
      ["retry:current-at-limit", MAX, 0, 150],
      ["retry:way-over", 82, 0, 200],
      ["retry:carried-over", 5, MAX, 299],
      ["retry:both-full", MAX, MAX, 250],
    ];

    for (const [id, current, previous, offset] of cases) {
      await seed(id, current, previous, offset);
      const result = await check(id);

      expect(result.allowed).toBe(false);
      expect(result.reset_in_seconds).toBeGreaterThan(0);
      expect(result.reset_in_seconds).toBeLessThanOrEqual(2 * WINDOW_S + 1);
    }
  });

  test("an elapsed window rolls: the current count becomes the previous count", async () => {
    const id = "roll:one-window";
    // Window ended 60s ago (less than one window ago), so exactly one window
    // has elapsed and the burst it contains must still partially count.
    await seed(id, 12, 7, -60);

    const result = await check(id);

    // After the roll: previous = 12, current = 0, reset = old reset + window,
    // i.e. now + 240s. weight = 240/300 = 0.8 -> estimate = 12 * 0.8 = 9.6.
    expect(result.allowed).toBe(true);
    expect(result.request_count).toBe(11); // CEIL(9.6) + 1 for this request
    expect(result.reset_in_seconds).toBeGreaterThan(235);
    expect(result.reset_in_seconds).toBeLessThan(245);

    const stored = await readRow(id);
    // The roll must be PERSISTED, otherwise every subsequent call recomputes it
    // from the same stale row and the counters never advance.
    expect(stored.previous_count).toBe(12); // old current carried over
    expect(stored.request_count).toBe(1); // current reset, then this request
  });

  test("an identifier idle for more than one window resets both counts", async () => {
    const id = "roll:long-idle";
    // Window ended 400s ago — more than one full window (300s), so nothing from
    // the old window still falls inside the trailing window.
    await seed(id, 25, MAX, -400);

    const result = await check(id);

    expect(result.allowed).toBe(true);
    expect(result.request_count).toBe(1); // estimate 0, plus this request

    const stored = await readRow(id);
    expect(stored.request_count).toBe(1);
    expect(stored.previous_count).toBe(0); // nothing carried; no phantom debt
    // A fully fresh window, not a continuation of the abandoned one.
    expect(stored.reset_in_seconds).toBeGreaterThan(WINDOW_S - 5);
    expect(stored.reset_in_seconds).toBeLessThanOrEqual(WINDOW_S + 1);
  });

  test("the previous window's count decays as its weight falls", async () => {
    // This is the property that distinguishes a sliding window from the fixed
    // window in 004: capacity comes back gradually instead of all at once.

    // Half the window left -> the previous window's 30 requests count as ~15,
    // leaving real headroom. Under 004 this client would still be locked out.
    const halfway = "decay:half-weight";
    await seed(halfway, 0, MAX, 150);
    const half = await check(halfway);
    expect(half.allowed).toBe(true);
    // estimate = 30 * 0.5 = 15 -> CEIL(15) + 1 = 16. Seeding drift can nudge
    // the weight a hair below 0.5, so allow one unit of slack either way.
    expect(half.request_count).toBeGreaterThanOrEqual(15);
    expect(half.request_count).toBeLessThanOrEqual(17);
    // The point of the case: meaningful budget remains.
    expect(half.request_count).toBeLessThan(MAX);

    // Almost the whole window left -> the previous window's burst still counts
    // at nearly full weight, so the client stays denied.
    const nearlyFull = "decay:near-full-weight";
    await seed(nearlyFull, 0, MAX + 1, 299);
    const full = await check(nearlyFull);
    // estimate = 31 * (299/300) = 30.9 >= 30
    expect(full.allowed).toBe(false);
    // ...but capacity is close, so Retry-After must be small, not a full window.
    // retry = reset - window * (30/31) = now + 299 - 290.3 ~= now + 9s.
    expect(full.reset_in_seconds).toBeGreaterThan(0);
    expect(full.reset_in_seconds).toBeLessThan(30);
  });

  test("009 regression: a stale reset_time from a longer window is clamped", async () => {
    // REGRESSION TEST for migration 009 — the most important case in this file.
    //
    // Rows written under the old 1-hour config carry a reset_time far beyond
    // the 5-minute window now being passed in. In 008 the boundary was only
    // recomputed once it had ELAPSED, so such a row kept its distant boundary
    // forever:
    //
    //   weight = (reset_time - now) / window = 2400s / 300s = 8.0 -> LEAST(1.0) = 1.0
    //
    // The weight pinned at 1.0, the window never rolled, the count never
    // decayed, and Retry-After was computed off the distant boundary:
    //
    //   before 009: (now + 2400 + 300) - 300 * (30/82) = now + 2590s = 43.2 min
    //   after  009: reset clamps to now + 300, giving
    //               (now + 300 + 300) - 300 * (30/82) = now + 490s = 8.2 min
    //
    // 43 minutes is exactly the lockout that 008 exists to eliminate.
    const id = "clamp:stale-hour-window";
    await seed(id, 82, 0, 2400); // 40 minutes out, from the old 1-hour config

    const result = await check(id, MAX, WINDOW_MS);

    expect(result.allowed).toBe(false);
    expect(result.request_count).toBe(82);

    // The assertion that fails without 009: Retry-After must fit inside two
    // windows (600s), not trail the stale 2400s boundary.
    expect(result.reset_in_seconds).toBeGreaterThan(0);
    expect(result.reset_in_seconds).toBeLessThanOrEqual(2 * WINDOW_S);
    // Tighter: the measured post-fix value is ~490s. Well under the ~2590s
    // that 008 produced.
    expect(result.reset_in_seconds).toBeGreaterThan(400);
    expect(result.reset_in_seconds).toBeLessThan(560);

    // The clamp must also be persisted, so the row self-heals: the next request
    // sees an in-range boundary rather than recomputing the clamp forever.
    const stored = await readRow(id);
    expect(stored.reset_in_seconds).toBeLessThanOrEqual(WINDOW_S + 1);
    expect(stored.reset_in_seconds).toBeGreaterThan(WINDOW_S - 5);
  });

  test("identifiers hold independent budgets", async () => {
    // The middleware builds `${ip}:${path}[:${scope}]` identifiers precisely so
    // one exhausted bucket cannot deny another (a dead refresh_token loop must
    // not consume the authorization_code budget).
    const exhausted = "1.2.3.4:/token:refresh_token";
    const healthy = "1.2.3.4:/token:authorization_code";

    await seed(exhausted, MAX, 0, 150);

    expect((await check(exhausted)).allowed).toBe(false);
    expect(await check(healthy)).toMatchObject({ allowed: true, request_count: 1 });
  });
});
