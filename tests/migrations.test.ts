/**
 * Tests for the SQL migrations in supabase/migrations.
 *
 * These migrations are applied by hand against a hosted Supabase project, so
 * nothing else in CI would ever notice a migration that no longer applies —
 * a typo, a column referenced before it is added, or two files that apply fine
 * individually but not in sequence. `createTestSchema()` applies every file in
 * filename order into a throwaway schema, so "it did not throw" is the
 * assertion that matters here.
 *
 * The structural assertions that follow pin the shape the application code
 * actually depends on: the tables the stores read/write, and specifically the
 * columns added by later migrations (006/007/008), which are the ones a missed
 * or out-of-order migration would silently drop.
 */
import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { createTestSchema, hasDatabase, type TestDb } from "./helpers/db.ts";

const MIGRATIONS_DIR = join(import.meta.dir, "..", "supabase", "migrations");

/** Every table the application code touches, and the migration that creates it. */
const EXPECTED_TABLES = [
  "mcp_tokens", // 001
  "oauth_sessions", // 001
  "auth_codes", // 001
  "registered_clients", // 001
  "rate_limits", // 001
  "tool_analytics", // 003
  "mcp_sessions", // 006
];

/**
 * Columns introduced after the initial schema. Each one is load-bearing: if the
 * migration that adds it is skipped, the corresponding feature fails at runtime
 * rather than at deploy time.
 */
const EXPECTED_ADDED_COLUMNS: Array<[table: string, column: string, why: string]> = [
  ["mcp_sessions", "session_id", "006: session -> token registry, so a restarted instance rebuilds sessions instead of 404ing"],
  ["mcp_tokens", "previous_mcp_token", "007: rotation grace window that makes refresh_token retries idempotent"],
  ["rate_limits", "previous_count", "008: the second counter the sliding window weights"],
];

describe("migration files", () => {
  test("filenames sort lexicographically in numeric order", async () => {
    // createTestSchema() applies files in plain `.sort()` order, so a file
    // numbered without zero padding (e.g. `10_x.sql`) would apply BEFORE
    // `002_x.sql` and break the sequence. Guard the naming convention itself;
    // this needs no database.
    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();

    expect(files.length).toBeGreaterThan(0);

    const prefixes = files.map((f) => {
      const match = /^(\d+)_/.exec(f);
      expect(match, `migration ${f} must start with a zero-padded numeric prefix`).not.toBeNull();
      return { file: f, width: match![1].length, value: Number(match![1]) };
    });

    // Uniform prefix width is what makes lexicographic order == numeric order.
    const widths = new Set(prefixes.map((p) => p.width));
    expect([...widths]).toHaveLength(1);

    const values = prefixes.map((p) => p.value);
    expect(values).toEqual([...values].sort((a, b) => a - b));
    // No duplicate numbers: two files sharing a prefix have undefined ordering.
    expect(new Set(values).size).toBe(values.length);
  });
});

describe.skipIf(!hasDatabase)("migrations applied to Postgres", () => {
  let db!: TestDb;

  beforeAll(async () => {
    db = await createTestSchema("migrations");
  });

  afterAll(async () => {
    await db?.drop();
  });

  test("every migration applies cleanly, in filename order, into a fresh schema", async () => {
    // The point of this test is that createTestSchema() resolves at all: it
    // rethrows as `migration <file> failed against the test schema: ...`, which
    // names the offending file. A second, independent schema is built here so
    // the assertion is about a genuinely fresh apply rather than the shared one.
    const fresh = await createTestSchema("migrations_fresh");
    try {
      expect(fresh.schema).toMatch(/^test_migrations_fresh_/);
    } finally {
      await fresh.drop();
    }
  });

  test("creates every table the application depends on", async () => {
    const rows = await db.sql.unsafe(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = $1
          AND table_type = 'BASE TABLE'`,
      [db.schema]
    );
    const actual = new Set(rows.map((r: { table_name: string }) => r.table_name));

    for (const table of EXPECTED_TABLES) {
      expect(actual.has(table), `expected table ${table} to exist after migrations`).toBe(true);
    }
  });

  test("adds the columns introduced by migrations 006, 007 and 008", async () => {
    const rows = await db.sql.unsafe(
      `SELECT table_name, column_name
         FROM information_schema.columns
        WHERE table_schema = $1`,
      [db.schema]
    );
    const actual = new Set(
      rows.map((r: { table_name: string; column_name: string }) => `${r.table_name}.${r.column_name}`)
    );

    for (const [table, column, why] of EXPECTED_ADDED_COLUMNS) {
      expect(actual.has(`${table}.${column}`), `${table}.${column} missing — ${why}`).toBe(true);
    }
  });

  test("rate_limits.previous_count is NOT NULL with a 0 default", async () => {
    // 008 adds this column to a table that already has rows in production. If
    // it were nullable, `previous_count * weight` would evaluate to NULL for
    // pre-existing rows and the estimate comparison would silently fall through
    // to "allowed", disabling rate limiting for every existing identifier.
    const rows = await db.sql.unsafe(
      `SELECT is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = 'rate_limits' AND column_name = 'previous_count'`,
      [db.schema]
    );

    expect(rows).toHaveLength(1);
    expect(rows[0].is_nullable).toBe("NO");
    expect(String(rows[0].column_default)).toContain("0");
  });

  test("leaves exactly one check_rate_limit function, with the signature the app calls", async () => {
    // 004, 008 and 009 all CREATE OR REPLACE this function. Replacement only
    // happens when the argument list matches exactly — change an argument type
    // in a later migration and Postgres creates an OVERLOAD instead, leaving
    // the old buggy definition live and making the PostgREST rpc() call
    // ambiguous.
    //
    // The parameter NAMES are load-bearing, not just the types:
    // src/server/rate-limiter.ts calls
    //   supabase.rpc("check_rate_limit", { p_identifier, p_max_requests, p_window_ms })
    // and PostgREST binds those by name. Renaming a parameter in a migration
    // would leave the SQL valid but break every call at runtime, so assert the
    // full identity — which is what pg_get_function_identity_arguments returns.
    const rows = await db.sql.unsafe(
      `SELECT pg_get_function_identity_arguments(p.oid) AS args
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = 'check_rate_limit'`,
      [db.schema]
    );

    expect(rows).toHaveLength(1);
    expect(String(rows[0].args)).toBe(
      "p_identifier character varying, p_max_requests integer, p_window_ms bigint"
    );
  });

  test("the live check_rate_limit is the clamped version from 009", async () => {
    // 009 is the last migration to replace the function; if it were skipped or
    // applied out of order, the stale-boundary clamp would be absent and the
    // ~43-minute Retry-After bug would be back. Assert on the clamp itself
    // rather than a comment, so a reworded header does not fail the test.
    const rows = await db.sql.unsafe(
      `SELECT prosrc
         FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = $1 AND p.proname = 'check_rate_limit'`,
      [db.schema]
    );

    const source = String(rows[0].prosrc).replace(/\s+/g, " ");
    expect(source).toContain("IF v_reset_time > v_now + v_window THEN");
    expect(source).toContain("v_reset_time := v_now + v_window;");
  });
});
