/**
 * Minimal in-memory stand-in for the supabase-js query builder, so store logic
 * can be tested without a database.
 *
 * Only the surface this codebase actually uses is implemented:
 *   .from(t).select(c).eq(c,v).gt(c,v).single()
 *   .from(t).insert(p) / .upsert(p, { onConflict }) / .update(p).eq(...) / .delete().eq(...)
 *   .update(p).eq(...).select(c)          <- rotateToken's race detection
 *   .rpc(fn, params).single()
 *
 * Wire it in with Bun's module mocking:
 *
 *   import { mock } from "bun:test";
 *   const fake = makeFakeSupabase({ mcp_tokens: (op) => ({ data: ..., error: null }) });
 *   mock.module("../src/db/supabase.js", () => ({ getSupabaseClient: () => fake.client }));
 */

export interface Filter {
  column: string;
  op: "eq" | "gt";
  value: unknown;
}

export interface Operation {
  table: string;
  action: "select" | "insert" | "upsert" | "update" | "delete" | "rpc";
  filters: Filter[];
  payload?: unknown;
  onConflict?: string;
  /** true when .select() was chained AFTER a mutation (return=representation) */
  returning: boolean;
  /** true when .single() terminated the chain */
  single: boolean;
}

export interface Result {
  data: unknown;
  error: { message: string; code?: string } | null;
}

export type Handler = (op: Operation) => Result;

const NOT_HANDLED: Result = {
  data: null,
  error: { message: "no handler registered for this operation", code: "TEST" },
};

export function makeFakeSupabase(handlers: Record<string, Handler>) {
  const calls: Operation[] = [];

  type Chain = Promise<Result> & {
    select(columns?: string): Chain;
    eq(column: string, value: unknown): Chain;
    gt(column: string, value: unknown): Chain;
    single(): Chain;
  };

  function builder(op: Operation): Chain {
    const run = (): Result => {
      calls.push({ ...op, filters: [...op.filters] });
      const handler = handlers[op.table];
      return handler ? handler(op) : NOT_HANDLED;
    };

    // A real Promise rather than a hand-rolled thenable. Resolution is deferred
    // to a microtask so the entire synchronous chain (.eq().gt().single()) is
    // built before the handler inspects the operation — which mirrors
    // supabase-js, where nothing is issued until the builder is awaited.
    const settled = new Promise<Result>((resolve) => {
      queueMicrotask(() => resolve(run()));
    });

    const chain = Object.assign(settled, {
      select(_columns?: string) {
        // .select() after a mutation means "return the affected rows"
        if (op.action !== "select") op.returning = true;
        return chain;
      },
      eq(column: string, value: unknown) {
        op.filters.push({ column, op: "eq", value });
        return chain;
      },
      gt(column: string, value: unknown) {
        op.filters.push({ column, op: "gt", value });
        return chain;
      },
      single() {
        op.single = true;
        return chain;
      },
    }) as Chain;

    return chain;
  }

  const client = {
    from(table: string) {
      const base = (action: Operation["action"], payload?: unknown, onConflict?: string) =>
        builder({ table, action, filters: [], payload, onConflict, returning: false, single: false });

      return {
        select: (columns?: string) => base("select").select(columns),
        insert: (payload: unknown) => base("insert", payload),
        upsert: (payload: unknown, opts?: { onConflict?: string }) =>
          base("upsert", payload, opts?.onConflict),
        update: (payload: unknown) => base("update", payload),
        delete: () => base("delete"),
      };
    },
    rpc(fn: string, params?: unknown) {
      return builder({
        table: fn,
        action: "rpc",
        filters: [],
        payload: params,
        returning: false,
        single: false,
      });
    },
  };

  return {
    client,
    calls,
    /** operations recorded against a given table/function, in order */
    callsFor(table: string) {
      return calls.filter((c) => c.table === table);
    },
    reset() {
      calls.length = 0;
    },
  };
}

/** Convenience: a handler that always returns rows. */
export const rows = (data: unknown): Handler => () => ({ data, error: null });

/** Convenience: a handler that always returns "no rows" the way PostgREST does. */
export const noRows: Handler = () => ({
  data: null,
  error: { message: "no rows returned", code: "PGRST116" },
});
