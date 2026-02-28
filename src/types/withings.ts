/**
 * Type definitions for Withings API integration.
 * Centralizes type aliases for dynamic API data structures.
 */

/** Parameters for Withings API requests (mixed string/number/boolean values) */
// deno-lint-ignore no-explicit-any
export type ApiParams = Record<string, any>;

/** Response body from Withings API (dynamic JSON structure) */
// deno-lint-ignore no-explicit-any
export type ApiResponse = any;
