/**
 * Unit tests for src/utils/logger.ts
 *
 * Redaction here is security-relevant: this repository is public and its logs
 * must never carry credentials. These tests pin the redaction behaviour, and
 * also document one real limitation of it (see "KNOWN GAP" below).
 */
import { describe, test, expect, spyOn, beforeEach, afterEach } from "bun:test";
import {
  logger,
  createLogger,
  calculateDateRangeDays,
  categorizeError,
} from "../src/utils/logger.js";

type Spy = ReturnType<typeof spyOn>;

let logSpy: Spy;
let warnSpy: Spy;
let errorSpy: Spy;
let originalLogLevel: string | undefined;

beforeEach(() => {
  originalLogLevel = process.env.LOG_LEVEL;
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
  errorSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  logSpy.mockRestore();
  warnSpy.mockRestore();
  errorSpy.mockRestore();
  if (originalLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = originalLogLevel;
});

/** The logger reads LOG_LEVEL in its constructor, so build it after setting env. */
function loggerAtLevel(level: string, context: Record<string, unknown> = {}) {
  process.env.LOG_LEVEL = level;
  return logger.child(context);
}

/** Last string handed to console.log. */
function lastLog(): string {
  const calls = logSpy.mock.calls;
  return String(calls[calls.length - 1]?.[0]);
}

/** The JSON blob appended after the message, parsed back into an object. */
function lastLoggedData(): Record<string, unknown> {
  const output = lastLog();
  const jsonStart = output.indexOf("{");
  return JSON.parse(output.slice(jsonStart));
}

// The full redaction list as it exists in src/utils/logger.ts today.
const REDACTED_KEYS = [
  "token",
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "bearer",
  "authorization",
  "Authorization",
  "code",
  "auth_code",
  "authCode",
  "client_secret",
  "clientSecret",
  "code_verifier",
  "codeVerifier",
  "code_challenge",
  "codeChallenge",
  "userid",
  "userId",
  "user_id",
  "email",
  "password",
  "sessionId",
  "session_id",
  "state",
  "apiKey",
  "api_key",
  "secret",
];

describe("redaction of sensitive keys", () => {
  test.each(REDACTED_KEYS)("redacts %s", (key) => {
    const log = loggerAtLevel("trace");
    log.info("event", { [key]: "SUPER-SECRET-VALUE" });

    const data = lastLoggedData();
    expect(data[key]).toBe("[REDACTED]");
    expect(lastLog()).not.toContain("SUPER-SECRET-VALUE");
  });

  test("redacts every sensitive key in one payload", () => {
    const log = loggerAtLevel("trace");
    const payload: Record<string, unknown> = {};
    for (const key of REDACTED_KEYS) payload[key] = "SUPER-SECRET-VALUE";
    log.info("event", payload);

    const data = lastLoggedData();
    for (const key of REDACTED_KEYS) expect(data[key]).toBe("[REDACTED]");
    expect(lastLog()).not.toContain("SUPER-SECRET-VALUE");
  });

  test("redacts the specific keys named in the privacy policy", () => {
    const log = loggerAtLevel("trace");
    log.info("oauth", {
      token: "t",
      access_token: "at",
      code: "c",
      client_secret: "cs",
      code_verifier: "cv",
      userid: 12345,
      email: "user@example.com",
      password: "hunter2",
      sessionId: "sess-1",
      state: "st",
    });

    const output = lastLog();
    for (const value of [
      "hunter2",
      "user@example.com",
      "12345",
      "sess-1",
      "cs",
      "cv",
    ]) {
      expect(output).not.toContain(value);
    }
    expect(lastLoggedData()).toEqual({
      token: "[REDACTED]",
      access_token: "[REDACTED]",
      code: "[REDACTED]",
      client_secret: "[REDACTED]",
      code_verifier: "[REDACTED]",
      userid: "[REDACTED]",
      email: "[REDACTED]",
      password: "[REDACTED]",
      sessionId: "[REDACTED]",
      state: "[REDACTED]",
    });
  });

  test("redacts non-string values too (numbers, objects, arrays)", () => {
    const log = loggerAtLevel("trace");
    log.info("event", {
      userid: 987654,
      token: { value: "nested-secret" },
      state: ["a", "b"],
    });

    expect(lastLoggedData()).toEqual({
      userid: "[REDACTED]",
      token: "[REDACTED]",
      state: "[REDACTED]",
    });
    expect(lastLog()).not.toContain("nested-secret");
  });

  test("reaches nested objects at any depth", () => {
    const log = loggerAtLevel("trace");
    log.info("nested", {
      request: {
        headers: { authorization: "Bearer abc123" },
        body: { deep: { deeper: { client_secret: "shhh", keep: "visible" } } },
      },
    });

    const output = lastLog();
    expect(output).not.toContain("Bearer abc123");
    expect(output).not.toContain("shhh");
    expect(lastLoggedData()).toEqual({
      request: {
        headers: { authorization: "[REDACTED]" },
        body: { deep: { deeper: { client_secret: "[REDACTED]", keep: "visible" } } },
      },
    });
  });

  test("reaches objects inside arrays", () => {
    const log = loggerAtLevel("trace");
    log.info("batch", {
      sessions: [
        { sessionId: "s1", tool: "get_sleep" },
        { sessionId: "s2", tool: "get_measures" },
      ],
    });

    expect(lastLoggedData()).toEqual({
      sessions: [
        { sessionId: "[REDACTED]", tool: "get_sleep" },
        { sessionId: "[REDACTED]", tool: "get_measures" },
      ],
    });
  });

  test("non-sensitive keys pass through untouched", () => {
    const log = loggerAtLevel("trace");
    log.info("tool call", {
      component: "tools:sleep",
      tool: "get_sleep_summary",
      durationMs: 143,
      ok: true,
      rangeDays: 7,
      nothing: null,
      nested: { status: 0, more: false },
    });

    expect(lastLoggedData()).toEqual({
      component: "tools:sleep",
      tool: "get_sleep_summary",
      durationMs: 143,
      ok: true,
      rangeDays: 7,
      nothing: null,
      nested: { status: 0, more: false },
    });
  });

  test("matching is exact and case-sensitive — near-miss keys are NOT redacted", () => {
    const log = loggerAtLevel("trace");
    log.info("near misses", {
      tokenCount: 42,
      my_token: "visible",
      TOKEN: "visible",
      Email: "visible",
      user: "visible",
    });

    const data = lastLoggedData();
    expect(data.tokenCount).toBe(42);
    expect(data.my_token).toBe("visible");
    expect(data.TOKEN).toBe("visible");
    expect(data.Email).toBe("visible");
    expect(data.user).toBe("visible");
  });

  // KNOWN GAP: redaction walks object KEYS only. A secret interpolated into the
  // message string, or one that appears as an array/scalar VALUE rather than
  // under a sensitive key, is logged verbatim. This test records the current
  // behaviour so a future change to it is a deliberate, visible decision — it
  // is not an endorsement. Callers must keep secrets out of message strings.
  test("KNOWN GAP: secrets embedded in the message string are NOT redacted", () => {
    const log = loggerAtLevel("trace");
    log.info("Exchanging code abc123secret for a token");

    expect(lastLog()).toContain("abc123secret");
  });

  test("KNOWN GAP: secrets appearing as values under a safe key are NOT redacted", () => {
    const log = loggerAtLevel("trace");
    log.info("event", { details: "client_secret=abc123secret", values: ["abc123secret"] });

    expect(lastLog()).toContain("abc123secret");
    expect(lastLoggedData()).toEqual({
      details: "client_secret=abc123secret",
      values: ["abc123secret"],
    });
  });
});

describe("log level filtering", () => {
  const emitAll = (level: string) => {
    const log = loggerAtLevel(level, { component: "test" });
    log.trace("t");
    log.debug("d");
    log.info("i");
    log.warn("w");
    log.error("e");
  };

  test("LOG_LEVEL=info suppresses trace and debug", () => {
    emitAll("info");

    const messages = logSpy.mock.calls.map((c: unknown[]) => String(c[0]));
    expect(messages).toEqual(["INFO  [test] i"]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("LOG_LEVEL=trace emits everything", () => {
    emitAll("trace");

    expect(logSpy).toHaveBeenCalledTimes(3); // trace + debug + info
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("LOG_LEVEL=debug emits debug and above but not trace", () => {
    emitAll("debug");

    expect(logSpy).toHaveBeenCalledTimes(2); // debug + info
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("LOG_LEVEL=warn suppresses everything below warn", () => {
    emitAll("warn");

    expect(logSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("LOG_LEVEL=error only emits errors", () => {
    emitAll("error");

    expect(logSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledTimes(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("LOG_LEVEL is case-insensitive", () => {
    emitAll("ERROR");

    expect(logSpy).toHaveBeenCalledTimes(0);
    expect(warnSpy).toHaveBeenCalledTimes(0);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("an unrecognised LOG_LEVEL falls back to info", () => {
    emitAll("gibberish");

    expect(logSpy).toHaveBeenCalledTimes(1); // info only
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  test("an unset LOG_LEVEL defaults to info", () => {
    delete process.env.LOG_LEVEL;
    const log = logger.child({ component: "test" });
    log.debug("d");
    log.info("i");

    expect(logSpy).toHaveBeenCalledTimes(1);
  });
});

describe("output format and routing", () => {
  test("routes error to console.error, warn to console.warn, rest to console.log", () => {
    const log = loggerAtLevel("trace", { component: "oauth" });

    log.error("boom");
    expect(String(errorSpy.mock.calls[0]?.[0])).toBe("ERROR [oauth] boom");

    log.warn("careful");
    expect(String(warnSpy.mock.calls[0]?.[0])).toBe("WARN  [oauth] careful");

    log.info("hello");
    expect(lastLog()).toBe("INFO  [oauth] hello");

    log.debug("details");
    expect(lastLog()).toBe("DEBUG [oauth] details");

    log.trace("very detailed");
    expect(lastLog()).toBe("TRACE [oauth] very detailed");
  });

  test("omits the component prefix when there is no component in context", () => {
    const log = loggerAtLevel("trace");
    log.info("plain message");

    expect(lastLog()).toBe("INFO  plain message");
  });

  test("appends the redacted payload as JSON after the message", () => {
    const log = loggerAtLevel("trace", { component: "oauth" });
    log.info("Starting OAuth authorization flow", { clientKnown: true, token: "x" });

    expect(lastLog()).toBe(
      'INFO  [oauth] Starting OAuth authorization flow {"clientKnown":true,"token":"[REDACTED]"}'
    );
  });

  test("falsy data payloads are omitted entirely", () => {
    const log = loggerAtLevel("trace");

    log.info("no data");
    expect(lastLog()).toBe("INFO  no data");

    log.info("zero", 0);
    expect(lastLog()).toBe("INFO  zero");

    log.info("empty string", "");
    expect(lastLog()).toBe("INFO  empty string");

    log.info("null", null);
    expect(lastLog()).toBe("INFO  null");

    // ...but an empty object is truthy and is serialised.
    log.info("empty object", {});
    expect(lastLog()).toBe("INFO  empty object {}");
  });

  test("primitive (non-object) data is serialised without redaction", () => {
    const log = loggerAtLevel("trace");
    log.info("count", 42);
    expect(lastLog()).toBe("INFO  count 42");
  });
});

describe("createLogger and child contexts", () => {
  test("createLogger attaches the component to the output", () => {
    process.env.LOG_LEVEL = "trace";
    const log = createLogger({ component: "tools:sleep" });
    log.info("get_sleep invoked");

    expect(lastLog()).toBe("INFO  [tools:sleep] get_sleep invoked");
  });

  test("child merges context, with the child's value winning", () => {
    process.env.LOG_LEVEL = "trace";
    const parent = createLogger({ component: "oauth" });
    const child = parent.child({ component: "oauth:callback" });

    child.info("callback received");
    expect(lastLog()).toBe("INFO  [oauth:callback] callback received");

    parent.info("still oauth");
    expect(lastLog()).toBe("INFO  [oauth] still oauth");
  });

  test("child loggers redact exactly like their parent", () => {
    process.env.LOG_LEVEL = "trace";
    createLogger({ component: "middleware" }).info("auth", {
      authorization: "Bearer leak",
    });

    expect(lastLog()).not.toContain("Bearer leak");
    expect(lastLoggedData()).toEqual({ authorization: "[REDACTED]" });
  });
});

describe("calculateDateRangeDays", () => {
  test("returns the day span between two valid dates", () => {
    expect(calculateDateRangeDays("2024-01-01", "2024-01-31")).toBe(30);
    expect(calculateDateRangeDays("2024-01-15", "2024-01-15")).toBe(0);
    expect(calculateDateRangeDays("2024-02-28", "2024-03-01")).toBe(2); // leap year
  });

  test("returns undefined for missing, malformed or reversed ranges", () => {
    expect(calculateDateRangeDays(undefined, "2024-01-31")).toBeUndefined();
    expect(calculateDateRangeDays("2024-01-01", undefined)).toBeUndefined();
    expect(calculateDateRangeDays("01/01/2024", "2024-01-31")).toBeUndefined();
    expect(calculateDateRangeDays("2024-13-45", "2024-01-31")).toBeUndefined();
    expect(calculateDateRangeDays("2024-01-31", "2024-01-01")).toBeUndefined();
  });
});

describe("categorizeError", () => {
  test.each([
    ["Withings access token expired", "auth_expired"],
    ["Request failed with 401", "auth_expired"],
    ["Rate limit exceeded", "rate_limited"],
    ["429 Too Many Requests", "rate_limited"],
    ["Invalid date format: foo. Expected YYYY-MM-DD format.", "invalid_date_format"],
    ["signalid is required", "missing_required_param"],
    ["Withings API returned an error", "withings_api_error"],
    ["network unreachable", "network_error"],
    ["something else entirely", "unknown"],
  ])("categorises %j as %s", (message, expected) => {
    expect(categorizeError(new Error(message))).toBe(expected);
  });

  // The checks run in a fixed order, so an earlier pattern wins even when a
  // later one looks like a better fit. Documented rather than judged.
  test("earlier patterns win: 'startdate is required' is a date error, not a param error", () => {
    expect(categorizeError(new Error("startdate is required"))).toBe(
      "invalid_date_format"
    );
  });

  test("non-Error values are unknown", () => {
    expect(categorizeError("a string")).toBe("unknown");
    expect(categorizeError(null)).toBe("unknown");
    expect(categorizeError(undefined)).toBe("unknown");
  });
});
