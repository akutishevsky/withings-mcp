/**
 * Hono application environment type definitions.
 */
import type { Context, Next } from "hono";

/** Custom variables stored in Hono context */
export type AppEnv = {
  Variables: {
    accessToken: string;
    parsedBody?: unknown;
  };
};

/** Typed Hono context with app-specific variables */
export type AppContext = Context<AppEnv>;

/** Hono middleware next function */
export type AppNext = Next;
