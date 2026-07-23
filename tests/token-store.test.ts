/**
 * Unit tests for the MCP token rotation / refresh logic in src/auth/token-store.ts.
 *
 * These guard shipped bugs, not hypotheticals:
 *
 *  - `rotateToken()` used to be a bare `UPDATE ... WHERE mcp_token = old` with no
 *    check on rows affected. Under two concurrent refreshes BOTH reported success,
 *    and the loser handed its freshly minted token to the client even though the
 *    UPDATE had matched nothing. That token was never written, so it
 *    authenticated nothing and the client was stranded. It now chains `.select()`
 *    and returns a boolean the caller must respect.
 *
 *  - The session-ownership cascade after a rotation is deliberately non-fatal:
 *    mcp_tokens is already committed by then, so throwing would 500 the /token
 *    response while the client holds a token that no longer exists.
 *
 * Supabase is replaced wholesale by tests/helpers/fake-supabase.ts via Bun's
 * module mocking. Note the `.js` specifier: src/ imports `../db/supabase.js` for
 * a `.ts` file, so the mock has to use the same specifier to resolve to the same
 * module record. If the mock ever stops taking effect, the real
 * `getSupabaseClient()` throws "Supabase client not initialized" — these tests
 * fail loudly rather than silently passing. The "module mocking is wired up"
 * test below asserts that directly.
 */

// Must be set before anything calls encrypt()/decrypt(). Static imports are
// hoisted above this line, but src/utils/encryption.ts reads the secret lazily
// inside getMasterSecret(), and the modules under test are imported dynamically
// further down — after this assignment has run.
process.env.ENCRYPTION_SECRET =
  "test-only-throwaway-encryption-secret-not-a-real-key";

import { describe, test, expect, mock, beforeEach } from "bun:test";
import {
  makeFakeSupabase,
  rows,
  noRows,
  type Handler,
  type Operation,
} from "./helpers/fake-supabase.js";

type Fake = ReturnType<typeof makeFakeSupabase>;

// Mutable so each test can install its own table handlers; the mocked
// getSupabaseClient() reads it at call time, not at import time.
let fake: Fake = makeFakeSupabase({});

function useSupabase(handlers: Record<string, Handler>): Fake {
  fake = makeFakeSupabase(handlers);
  return fake;
}

mock.module("../src/db/supabase.js", () => ({
  getSupabaseClient: () => fake.client,
}));

const { tokenStore } = await import("../src/auth/token-store.js");
const { encrypt } = await import("../src/utils/encryption.js");

// Mirrors the constants in src/auth/token-store.ts.
const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ROTATION_GRACE_MS = 60 * 1000;

const OLD_TOKEN = "mcp-token-old-11111111";
const NEW_TOKEN = "mcp-token-new-22222222";

function tokenRow(overrides: Record<string, unknown> = {}) {
  return {
    mcp_token: OLD_TOKEN,
    encrypted_access_token: encrypt("withings-access-abc"),
    encrypted_refresh_token: encrypt("withings-refresh-xyz"),
    withings_user_id: "withings-user-42",
    withings_expires_at: 1_700_000_000,
    expires_at: new Date(Date.now() + TTL_MS).toISOString(),
    ...overrides,
  };
}

const findFilter = (op: Operation, column: string, kind: "eq" | "gt") =>
  op.filters.find((f) => f.column === column && f.op === kind);

/** Handler that answers an `UPDATE ... RETURNING` with the given affected rows. */
const updateAffects = (affected: unknown[]): Handler => () => ({
  data: affected,
  error: null,
});

/** mcp_sessions handler for a cascade that succeeds. */
const sessionsOk: Handler = () => ({ data: null, error: null });

/** mcp_sessions handler that makes sessionStore.rotateToken() throw. */
const sessionsBroken: Handler = () => ({
  data: null,
  error: { message: "sessions table unavailable" },
});

beforeEach(() => {
  // Default: no handlers registered, so any unexpected table access surfaces
  // as an explicit error instead of a silent pass.
  useSupabase({});
});

describe("module mocking is wired up", () => {
  test("the real token-store talks to the fake supabase client", async () => {
    const f = useSupabase({ mcp_tokens: noRows });

    // If mock.module had not resolved to src/db/supabase.ts, the real
    // getSupabaseClient() would throw "Supabase client not initialized".
    await expect(tokenStore.getTokens("anything")).resolves.toBeNull();

    expect(f.callsFor("mcp_tokens")).toHaveLength(1);
    expect(f.callsFor("mcp_tokens")[0]!.action).toBe("select");
  });
});

describe("rotateToken - concurrent rotation race detection", () => {
  test("returns TRUE when the UPDATE matched a row", async () => {
    useSupabase({
      mcp_tokens: updateAffects([{ mcp_token: NEW_TOKEN }]),
      mcp_sessions: sessionsOk,
    });

    await expect(tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN)).resolves.toBe(
      true
    );
  });

  test("returns FALSE when the UPDATE matched ZERO rows (lost the race)", async () => {
    // THE REGRESSION: a concurrent refresh already rotated OLD_TOKEN away, so
    // this UPDATE matches nothing. `data: []` is exactly what PostgREST returns
    // for an UPDATE ... RETURNING that affected no rows. Before the fix this
    // still reported success and NEW_TOKEN — a value never written to any row —
    // was handed to the client, which then authenticated nothing.
    const f = useSupabase({
      mcp_tokens: updateAffects([]),
      mcp_sessions: sessionsOk,
    });

    const rotated = await tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN);

    expect(rotated).toBe(false);
    expect(rotated).not.toBe(true); // the caller MUST NOT issue NEW_TOKEN

    // The UPDATE must actually ask for the affected rows back — without the
    // chained .select() there is nothing to count and the race is undetectable.
    const update = f.callsFor("mcp_tokens").at(-1)!;
    expect(update.action).toBe("update");
    expect(update.returning).toBe(true);

    // A rotation that did not happen must not drag sessions along with it.
    expect(f.callsFor("mcp_sessions")).toHaveLength(0);
  });

  test("returns FALSE when the driver reports no data at all", async () => {
    useSupabase({
      mcp_tokens: rows(null),
      mcp_sessions: sessionsOk,
    });

    await expect(tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN)).resolves.toBe(
      false
    );
  });

  test("the two outcomes are distinguishable from a single boolean", async () => {
    useSupabase({
      mcp_tokens: updateAffects([{ mcp_token: NEW_TOKEN }]),
      mcp_sessions: sessionsOk,
    });
    const won = await tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN);

    useSupabase({
      mcp_tokens: updateAffects([]),
      mcp_sessions: sessionsOk,
    });
    const lost = await tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN);

    expect([won, lost]).toEqual([true, false]);
  });
});

describe("rotateToken - written payload", () => {
  test("records the superseded token and a ~60s grace expiry", async () => {
    const f = useSupabase({
      mcp_tokens: updateAffects([{ mcp_token: NEW_TOKEN }]),
      mcp_sessions: sessionsOk,
    });

    const before = Date.now();
    await tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN);
    const after = Date.now();

    const ops = f.callsFor("mcp_tokens");
    expect(ops).toHaveLength(1);

    const op = ops[0]!;
    expect(op.action).toBe("update");
    expect(op.returning).toBe(true);

    const payload = op.payload as Record<string, string>;
    expect(payload.mcp_token).toBe(NEW_TOKEN);
    expect(payload.previous_mcp_token).toBe(OLD_TOKEN);

    // previous_token_expires_at ~= now + ROTATION_GRACE_MS (60s).
    const graceAt = Date.parse(payload.previous_token_expires_at!);
    expect(Number.isNaN(graceAt)).toBe(false);
    expect(graceAt).toBeGreaterThanOrEqual(before + ROTATION_GRACE_MS);
    expect(graceAt).toBeLessThanOrEqual(after + ROTATION_GRACE_MS);
    // Sanity: it is a short grace, not the 30-day TTL by accident.
    expect(graceAt - before).toBeLessThan(5 * 60 * 1000);

    // The row TTL is refreshed to the full 30 days.
    const expiresAt = Date.parse(payload.expires_at!);
    expect(expiresAt).toBeGreaterThanOrEqual(before + TTL_MS);
    expect(expiresAt).toBeLessThanOrEqual(after + TTL_MS);

    expect(Number.isNaN(Date.parse(payload.updated_at!))).toBe(false);

    // Targeted at the presented token only.
    expect(findFilter(op, "mcp_token", "eq")).toEqual({
      column: "mcp_token",
      op: "eq",
      value: OLD_TOKEN,
    });
  });
});

describe("rotateToken - database errors", () => {
  test("throws when Supabase returns an error", async () => {
    useSupabase({
      mcp_tokens: () => ({
        data: null,
        error: { message: "deadlock detected" },
      }),
      mcp_sessions: sessionsOk,
    });

    await expect(
      tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN)
    ).rejects.toThrow("Failed to rotate token: deadlock detected");
  });

  test("a database error is not silently downgraded to false", async () => {
    const f = useSupabase({
      mcp_tokens: () => ({ data: null, error: { message: "boom" } }),
      mcp_sessions: sessionsOk,
    });

    await expect(
      tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN)
    ).rejects.toThrow(/boom/);

    expect(f.callsFor("mcp_sessions")).toHaveLength(0);
  });
});

describe("rotateToken - session ownership cascade", () => {
  test("carries session ownership over to the new token", async () => {
    const f = useSupabase({
      mcp_tokens: updateAffects([{ mcp_token: NEW_TOKEN }]),
      mcp_sessions: sessionsOk,
    });

    await expect(tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN)).resolves.toBe(
      true
    );

    const sessionOps = f.callsFor("mcp_sessions");
    expect(sessionOps).toHaveLength(1);

    const op = sessionOps[0]!;
    expect(op.action).toBe("update");
    expect((op.payload as Record<string, string>).mcp_token).toBe(NEW_TOKEN);
    expect(findFilter(op, "mcp_token", "eq")).toEqual({
      column: "mcp_token",
      op: "eq",
      value: OLD_TOKEN,
    });
  });

  test("still resolves TRUE when the session cascade throws", async () => {
    // Deliberately non-fatal. mcp_tokens is already committed at this point, so
    // propagating would 500 the /token response after the rotation succeeded —
    // the client would keep a token that no longer exists and be locked out
    // until it redid the whole Withings OAuth flow. A stale session binding
    // costs one 403 and a reconnect instead.
    const f = useSupabase({
      mcp_tokens: updateAffects([{ mcp_token: NEW_TOKEN }]),
      mcp_sessions: sessionsBroken,
    });

    await expect(tokenStore.rotateToken(OLD_TOKEN, NEW_TOKEN)).resolves.toBe(
      true
    );

    // It genuinely attempted the cascade rather than skipping it.
    expect(f.callsFor("mcp_sessions")).toHaveLength(1);
  });
});

describe("resolveRefreshToken", () => {
  const PRESENTED = OLD_TOKEN;
  const CURRENT = NEW_TOKEN;

  /**
   * resolveRefreshToken makes up to two SELECTs against mcp_tokens; route them
   * by which column they filter on.
   */
  const byLookup = (opts: {
    live?: Handler;
    superseded?: Handler;
  }): Handler => (op) => {
    if (findFilter(op, "previous_mcp_token", "eq")) {
      return (opts.superseded ?? noRows)(op);
    }
    return (opts.live ?? noRows)(op);
  };

  test("resolves a live token with isReplay=false", async () => {
    const f = useSupabase({
      mcp_tokens: byLookup({ live: rows({ mcp_token: PRESENTED }) }),
    });

    await expect(tokenStore.resolveRefreshToken(PRESENTED)).resolves.toEqual({
      currentToken: PRESENTED,
      isReplay: false,
    });

    // Short-circuits: no second lookup when the token is still live.
    const ops = f.callsFor("mcp_tokens");
    expect(ops).toHaveLength(1);

    const op = ops[0]!;
    expect(op.action).toBe("select");
    expect(op.single).toBe(true);
    expect(findFilter(op, "mcp_token", "eq")?.value).toBe(PRESENTED);
    expect(findFilter(op, "expires_at", "gt")).toBeDefined();
  });

  test("resolves a superseded token inside the grace window to the CURRENT token", async () => {
    const f = useSupabase({
      mcp_tokens: byLookup({
        live: noRows,
        superseded: rows({ mcp_token: CURRENT }),
      }),
    });

    const before = new Date(Date.now() - 1).toISOString();
    const resolved = await tokenStore.resolveRefreshToken(PRESENTED);
    const after = new Date(Date.now() + 1).toISOString();

    // The caller must be handed the winner's token, not the one it presented.
    expect(resolved).toEqual({ currentToken: CURRENT, isReplay: true });
    expect(resolved!.currentToken).not.toBe(PRESENTED);

    const ops = f.callsFor("mcp_tokens");
    expect(ops).toHaveLength(2);

    const second = ops[1]!;
    expect(second.action).toBe("select");
    expect(second.single).toBe(true);

    // Matched on the superseded column...
    expect(findFilter(second, "previous_mcp_token", "eq")).toEqual({
      column: "previous_mcp_token",
      op: "eq",
      value: PRESENTED,
    });

    // ...and guarded by BOTH expiries: the 60s grace AND the row's own TTL.
    // Dropping either would keep a rotated-away token usable well past the
    // grace window.
    const grace = findFilter(second, "previous_token_expires_at", "gt");
    const ttl = findFilter(second, "expires_at", "gt");
    expect(grace).toBeDefined();
    expect(ttl).toBeDefined();

    for (const guard of [grace!, ttl!]) {
      const value = guard.value as string;
      expect(typeof value).toBe("string");
      expect(value >= before && value <= after).toBe(true);
    }
  });

  test("returns null when neither the live nor the grace lookup matches", async () => {
    const f = useSupabase({ mcp_tokens: byLookup({}) });

    await expect(
      tokenStore.resolveRefreshToken("mcp-token-never-issued")
    ).resolves.toBeNull();

    // Both lookups were genuinely attempted before giving up.
    expect(f.callsFor("mcp_tokens")).toHaveLength(2);
  });

  test("returns null when the grace window has elapsed (no matching row)", async () => {
    // Past the grace window the `previous_token_expires_at > now()` guard
    // filters the row out server-side, which surfaces as PGRST116 / no rows.
    const f = useSupabase({ mcp_tokens: byLookup({ superseded: noRows }) });

    await expect(tokenStore.resolveRefreshToken(PRESENTED)).resolves.toBeNull();
    expect(f.callsFor("mcp_tokens")).toHaveLength(2);
  });
});

describe("getTokens / isValid are unchanged", () => {
  test("returns decrypted Withings credentials for a live token", async () => {
    const f = useSupabase({ mcp_tokens: rows(tokenRow()) });

    const before = new Date(Date.now() - 1).toISOString();
    const data = await tokenStore.getTokens(OLD_TOKEN);
    const after = new Date(Date.now() + 1).toISOString();

    expect(data).toEqual({
      withingsAccessToken: "withings-access-abc",
      withingsRefreshToken: "withings-refresh-xyz",
      withingsUserId: "withings-user-42",
      expiresAt: 1_700_000_000,
    });

    const op = f.callsFor("mcp_tokens")[0]!;
    expect(op.action).toBe("select");
    expect(op.single).toBe(true);
    expect(findFilter(op, "mcp_token", "eq")?.value).toBe(OLD_TOKEN);

    const ttlGuard = findFilter(op, "expires_at", "gt")!;
    expect(ttlGuard).toBeDefined();
    const value = ttlGuard.value as string;
    expect(value >= before && value <= after).toBe(true);
  });

  test("returns null for a token with no matching row", async () => {
    useSupabase({ mcp_tokens: noRows });

    await expect(tokenStore.getTokens("mcp-token-missing")).resolves.toBeNull();
  });

  test("isValid is true for a live token", async () => {
    useSupabase({ mcp_tokens: rows(tokenRow()) });

    await expect(tokenStore.isValid(OLD_TOKEN)).resolves.toBe(true);
  });

  test("isValid is false for a missing token", async () => {
    useSupabase({ mcp_tokens: noRows });

    await expect(tokenStore.isValid("mcp-token-missing")).resolves.toBe(false);
  });
});
