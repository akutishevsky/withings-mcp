/**
 * Postgres harness for tests that exercise real SQL (migrations, plpgsql).
 *
 * Uses Bun's built-in SQL client, so no new dependency. Each caller gets its
 * own throwaway schema with the real migrations applied, so tests exercise the
 * migrations themselves rather than a hand-copied approximation — the class of
 * bug that motivated this suite only reproduced against a real Postgres.
 *
 * Set TEST_DATABASE_URL to run these. Without it they skip rather than fail, so
 * `bun test` still works on a machine with no database.
 *
 *   TEST_DATABASE_URL=postgres://postgres:postgres@localhost:5432/postgres bun test
 */
import { SQL } from "bun";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
export const hasDatabase = Boolean(TEST_DATABASE_URL);

const MIGRATIONS_DIR = join(import.meta.dir, "..", "..", "supabase", "migrations");

// Needs the pg_cron extension, which a vanilla Postgres does not have. Nothing
// in it affects application behaviour — it only schedules cleanup jobs.
const REQUIRES_UNAVAILABLE_EXTENSIONS = new Set(["005_pg_cron_cleanup.sql"]);

// Later migrations also tail a `SELECT cron.schedule(...)` onto an otherwise
// portable file. Strip those rather than skipping the whole file, so the table
// definitions around them still get exercised. Matches through to a line that
// begins with `);`, which is safe against the `$$ ... $$` bodies inside.
const CRON_SCHEDULE_STATEMENT = /SELECT\s+cron\.schedule\s*\([\s\S]*?\n\);/gi;

// Supabase provisions these roles; a stock Postgres does not, and several
// migrations grant policies TO them.
const SUPABASE_ROLES = ["service_role", "authenticated", "anon"];

export interface TestDb {
  sql: SQL;
  schema: string;
  drop: () => Promise<void>;
}

/**
 * Create an isolated schema, apply the real migrations into it, and return a
 * connection scoped to it. `max: 1` keeps a single connection so `search_path`
 * survives across queries.
 */
export async function createTestSchema(label: string): Promise<TestDb> {
  if (!TEST_DATABASE_URL) {
    throw new Error("createTestSchema() requires TEST_DATABASE_URL");
  }

  const schema = `test_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now().toString(36)}`;
  const sql = new SQL(TEST_DATABASE_URL, { max: 1 });

  // Roles referenced by the RLS policies. Idempotent so parallel test files
  // creating schemas against the same server do not race each other.
  for (const role of SUPABASE_ROLES) {
    await sql.unsafe(
      `DO $harness$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
           CREATE ROLE ${role};
         END IF;
       EXCEPTION WHEN duplicate_object THEN NULL;
       END $harness$;`
    );
  }

  await sql.unsafe(`CREATE SCHEMA "${schema}"`);
  await sql.unsafe(`SET search_path TO "${schema}", public`);

  const files = (await readdir(MIGRATIONS_DIR))
    .filter((f) => f.endsWith(".sql"))
    .filter((f) => !REQUIRES_UNAVAILABLE_EXTENSIONS.has(f))
    .sort();

  for (const file of files) {
    const raw = await readFile(join(MIGRATIONS_DIR, file), "utf8");
    const body = raw.replace(CRON_SCHEDULE_STATEMENT, "");
    try {
      await sql.unsafe(body);
    } catch (err) {
      throw new Error(
        `migration ${file} failed against the test schema: ${
          err instanceof Error ? err.message : String(err)
        }`
      );
    }
  }

  return {
    sql,
    schema,
    drop: async () => {
      await sql.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await sql.end();
    },
  };
}

/**
 * Freeze-free clock helper: most rate-limit assertions care about a moment
 * relative to a fixed origin rather than wall time.
 */
export function at(baseIso: string, offsetSeconds: number): string {
  return new Date(new Date(baseIso).getTime() + offsetSeconds * 1000).toISOString();
}
