/**
 * Unit tests for src/utils/timestamp.ts
 *
 * These tests assert what the code ACTUALLY does today, including a couple of
 * places where the real behaviour is looser than the doc comments suggest.
 * Those are called out inline as KNOWN GAP so the suite records reality rather
 * than an aspiration.
 */
import { describe, test, expect } from "bun:test";
import {
  dateToUnixTimestamp,
  formatTimestamp,
  formatTimestampWithTimezone,
  addReadableTimestamps,
  addReadableNightEvents,
} from "../src/utils/timestamp.js";

// Every key the module treats as a Unix timestamp (TIMESTAMP_FIELDS).
const TIMESTAMP_FIELDS = [
  "startdate",
  "enddate",
  "date",
  "created",
  "modified",
  "timestamp",
  "first_session_date",
  "last_session_date",
  "birthdate",
  "lastupdate",
];

// 2024-01-15T11:30:00Z — winter, so Europe/Paris is UTC+1.
const WINTER_TS = 1705318200;
// 2024-07-17T10:00:00Z — summer, so Europe/Paris is UTC+2 (CEST).
const SUMMER_TS = 1721210400;

describe("dateToUnixTimestamp", () => {
  test("converts YYYY-MM-DD to seconds at midnight UTC", () => {
    expect(dateToUnixTimestamp("2025-11-17")).toBe(1763337600);
    expect(dateToUnixTimestamp("1970-01-01")).toBe(0);
    expect(dateToUnixTimestamp("2024-02-29")).toBe(1709164800); // valid leap day
  });

  test("returns whole seconds, not milliseconds", () => {
    const ts = dateToUnixTimestamp("2025-06-01");
    expect(Number.isInteger(ts)).toBe(true);
    expect(ts % 86400).toBe(0);
  });

  test("handles dates before the epoch", () => {
    expect(dateToUnixTimestamp("1969-12-31")).toBe(-86400);
  });

  test.each([
    ["empty string", ""],
    ["missing separators", "20251117"],
    ["slash separators", "2025/11/17"],
    ["single-digit month", "2025-1-17"],
    ["single-digit day", "2025-11-7"],
    ["two-digit year", "25-11-17"],
    ["non-numeric", "abcd-ef-gh"],
    ["partially non-numeric", "2025-1a-17"],
    ["ISO datetime", "2025-11-17T00:00:00Z"],
    ["trailing whitespace", "2025-11-17 "],
  ])("rejects malformed input (%s)", (_label, input) => {
    expect(() => dateToUnixTimestamp(input)).toThrow(/Invalid date format/);
  });

  test("rejects month 0 and month 13", () => {
    expect(() => dateToUnixTimestamp("2025-00-15")).toThrow(
      "Invalid month: 0. Must be between 1 and 12."
    );
    expect(() => dateToUnixTimestamp("2025-13-15")).toThrow(
      "Invalid month: 13. Must be between 1 and 12."
    );
  });

  test("rejects day 0 and day 32", () => {
    expect(() => dateToUnixTimestamp("2025-01-00")).toThrow(
      "Invalid day: 0. Must be between 1 and 31."
    );
    expect(() => dateToUnixTimestamp("2025-01-32")).toThrow(
      "Invalid day: 32. Must be between 1 and 31."
    );
  });

  // KNOWN GAP: validation only range-checks month (1-12) and day (1-31); it
  // never checks the day against the actual length of that month. Date.UTC()
  // silently rolls the overflow forward, so calendar-impossible dates are
  // accepted and quietly resolve to a DIFFERENT day. Documented, not endorsed.
  test("KNOWN GAP: impossible dates roll over instead of throwing", () => {
    // 2025-02-30 does not exist; it becomes 2025-03-02.
    const rolled = dateToUnixTimestamp("2025-02-30");
    expect(formatTimestamp(rolled)).toBe("2025-03-02T00:00:00.000Z");

    // 2025 is not a leap year, so 2025-02-29 becomes 2025-03-01.
    expect(formatTimestamp(dateToUnixTimestamp("2025-02-29"))).toBe(
      "2025-03-01T00:00:00.000Z"
    );

    // 2025-04-31 does not exist; it becomes 2025-05-01.
    expect(formatTimestamp(dateToUnixTimestamp("2025-04-31"))).toBe(
      "2025-05-01T00:00:00.000Z"
    );
  });
});

describe("formatTimestamp", () => {
  test("formats as UTC ISO 8601 with milliseconds", () => {
    expect(formatTimestamp(WINTER_TS)).toBe("2024-01-15T11:30:00.000Z");
    expect(formatTimestamp(0)).toBe("1970-01-01T00:00:00.000Z");
  });

  test("truncates nothing — fractional seconds become milliseconds", () => {
    expect(formatTimestamp(1705318200.5)).toBe("2024-01-15T11:30:00.500Z");
  });
});

describe("formatTimestampWithTimezone", () => {
  test("formats a known timestamp in Europe/Paris", () => {
    expect(formatTimestampWithTimezone(WINTER_TS, "Europe/Paris")).toBe(
      "2024-01-15 12:30:00 Europe/Paris"
    );
  });

  test("formats a known timestamp in America/New_York", () => {
    expect(formatTimestampWithTimezone(WINTER_TS, "America/New_York")).toBe(
      "2024-01-15 06:30:00 America/New_York"
    );
  });

  test("respects DST: same zone shifts by an extra hour in summer", () => {
    // Winter: UTC 11:30 -> 12:30 local (UTC+1)
    expect(formatTimestampWithTimezone(WINTER_TS, "Europe/Paris")).toBe(
      "2024-01-15 12:30:00 Europe/Paris"
    );
    expect(formatTimestamp(WINTER_TS)).toBe("2024-01-15T11:30:00.000Z");

    // Summer: UTC 10:00 -> 12:00 local (UTC+2, CEST)
    expect(formatTimestampWithTimezone(SUMMER_TS, "Europe/Paris")).toBe(
      "2024-07-17 12:00:00 Europe/Paris"
    );
    expect(formatTimestamp(SUMMER_TS)).toBe("2024-07-17T10:00:00.000Z");
  });

  test("formats UTC midnight local time without hour12 artefacts", () => {
    // 2024-01-14T23:00:00Z is 2024-01-15 00:00:00 in Paris.
    expect(formatTimestampWithTimezone(1705273200, "Europe/Paris")).toBe(
      "2024-01-15 00:00:00 Europe/Paris"
    );
  });

  test("falls back to UTC ISO when the timezone is invalid", () => {
    expect(formatTimestampWithTimezone(WINTER_TS, "Not/AZone")).toBe(
      formatTimestamp(WINTER_TS)
    );
    expect(formatTimestampWithTimezone(WINTER_TS, "")).toBe(
      formatTimestamp(WINTER_TS)
    );
  });

  test("UTC as a named zone matches the ISO rendering", () => {
    expect(formatTimestampWithTimezone(WINTER_TS, "UTC")).toBe(
      "2024-01-15 11:30:00 UTC"
    );
  });
});

describe("addReadableTimestamps", () => {
  test("replaces every field in TIMESTAMP_FIELDS", () => {
    const input: Record<string, unknown> = {};
    for (const field of TIMESTAMP_FIELDS) input[field] = WINTER_TS;

    const out = addReadableTimestamps(input);

    for (const field of TIMESTAMP_FIELDS) {
      expect(out[field]).toBe("2024-01-15T11:30:00.000Z");
    }
  });

  test("uses the object's own timezone when present", () => {
    const out = addReadableTimestamps({
      timezone: "Europe/Paris",
      startdate: WINTER_TS,
      enddate: SUMMER_TS,
    });

    expect(out).toEqual({
      timezone: "Europe/Paris",
      startdate: "2024-01-15 12:30:00 Europe/Paris",
      enddate: "2024-07-17 12:00:00 Europe/Paris",
    });
  });

  test("falls back to UTC ISO when no timezone field is present", () => {
    const out = addReadableTimestamps({ startdate: WINTER_TS });
    expect(out.startdate).toBe("2024-01-15T11:30:00.000Z");
  });

  test("ignores a non-string or empty timezone and uses UTC", () => {
    expect(addReadableTimestamps({ timezone: "", startdate: WINTER_TS }).startdate).toBe(
      "2024-01-15T11:30:00.000Z"
    );
    expect(addReadableTimestamps({ timezone: 3600, startdate: WINTER_TS }).startdate).toBe(
      "2024-01-15T11:30:00.000Z"
    );
  });

  test("leaves unrelated fields untouched", () => {
    const out = addReadableTimestamps({
      startdate: WINTER_TS,
      steps: 8421,
      model: "Body Cardio",
      afib: 0,
      active: true,
      note: null,
      hr: [60, 61, 62],
    });

    expect(out.steps).toBe(8421);
    expect(out.model).toBe("Body Cardio");
    expect(out.afib).toBe(0);
    expect(out.active).toBe(true);
    expect(out.note).toBe(null);
    expect(out.hr).toEqual([60, 61, 62]);
    expect(out.startdate).toBe("2024-01-15T11:30:00.000Z");
  });

  test("only converts positive numbers — 0, negatives and strings pass through", () => {
    const out = addReadableTimestamps({
      startdate: 0,
      enddate: -1,
      date: "2024-01-15",
      created: "1705318200",
    });

    expect(out.startdate).toBe(0);
    expect(out.enddate).toBe(-1);
    expect(out.date).toBe("2024-01-15");
    expect(out.created).toBe("1705318200");
  });

  test("recurses into nested objects", () => {
    const out = addReadableTimestamps({
      body: {
        series: {
          startdate: WINTER_TS,
          nested: { enddate: WINTER_TS },
        },
      },
    });

    expect(out.body.series.startdate).toBe("2024-01-15T11:30:00.000Z");
    expect(out.body.series.nested.enddate).toBe("2024-01-15T11:30:00.000Z");
  });

  test("recurses into arrays, including arrays of objects", () => {
    const out = addReadableTimestamps({
      series: [
        { timezone: "Europe/Paris", startdate: WINTER_TS },
        { startdate: WINTER_TS },
      ],
    });

    expect(out.series[0].startdate).toBe("2024-01-15 12:30:00 Europe/Paris");
    expect(out.series[1].startdate).toBe("2024-01-15T11:30:00.000Z");
  });

  test("processes a top-level array", () => {
    const out = addReadableTimestamps([
      { timezone: "UTC", date: WINTER_TS },
      { date: WINTER_TS },
    ]);

    expect(Array.isArray(out)).toBe(true);
    expect(out[0].date).toBe("2024-01-15 11:30:00 UTC");
    expect(out[1].date).toBe("2024-01-15T11:30:00.000Z");
  });

  // Timezone is resolved per-object, not inherited down the tree.
  test("a nested object does NOT inherit the parent's timezone", () => {
    const out = addReadableTimestamps({
      timezone: "Europe/Paris",
      startdate: WINTER_TS,
      child: { startdate: WINTER_TS },
    });

    expect(out.startdate).toBe("2024-01-15 12:30:00 Europe/Paris");
    expect(out.child.startdate).toBe("2024-01-15T11:30:00.000Z");
  });

  test("returns null, undefined and primitives unchanged", () => {
    expect(addReadableTimestamps(null)).toBe(null);
    expect(addReadableTimestamps(undefined)).toBe(undefined);
    expect(addReadableTimestamps(42)).toBe(42);
    expect(addReadableTimestamps("hello")).toBe("hello");
    expect(addReadableTimestamps(false)).toBe(false);
  });

  test("does not mutate the input object", () => {
    const input = { startdate: WINTER_TS, nested: { enddate: WINTER_TS } };
    const out = addReadableTimestamps(input);

    expect(input.startdate).toBe(WINTER_TS);
    expect(input.nested.enddate).toBe(WINTER_TS);
    expect(out).not.toBe(input);
  });

  test("realistic Withings sleep summary shape", () => {
    const out = addReadableTimestamps({
      status: 0,
      body: {
        series: [
          {
            id: 1,
            timezone: "Europe/Paris",
            startdate: WINTER_TS,
            enddate: WINTER_TS + 3600,
            modified: WINTER_TS,
            data: { sleep_score: 82, hr_average: 55 },
          },
        ],
        more: false,
      },
    });

    expect(out.status).toBe(0);
    expect(out.body.more).toBe(false);
    expect(out.body.series[0].id).toBe(1);
    expect(out.body.series[0].startdate).toBe("2024-01-15 12:30:00 Europe/Paris");
    expect(out.body.series[0].enddate).toBe("2024-01-15 13:30:00 Europe/Paris");
    expect(out.body.series[0].modified).toBe("2024-01-15 12:30:00 Europe/Paris");
    expect(out.body.series[0].data).toEqual({ sleep_score: 82, hr_average: 55 });
  });
});

describe("addReadableNightEvents", () => {
  test("converts each timestamp array using the object's timezone", () => {
    const out = addReadableNightEvents({
      timezone: "Europe/Paris",
      startdate: WINTER_TS,
      night_events: {
        "1": [WINTER_TS, WINTER_TS + 60],
        "2": [SUMMER_TS],
      },
    });

    expect(out.night_events).toEqual({
      "1": ["2024-01-15 12:30:00 Europe/Paris", "2024-01-15 12:31:00 Europe/Paris"],
      "2": ["2024-07-17 12:00:00 Europe/Paris"],
    });
  });

  test("falls back to UTC ISO when no timezone is present", () => {
    const out = addReadableNightEvents({
      night_events: { "1": [WINTER_TS] },
    });

    expect(out.night_events).toEqual({ "1": ["2024-01-15T11:30:00.000Z"] });
  });

  test("leaves sibling fields intact and does not mutate the input", () => {
    const input = {
      timezone: "UTC",
      sleep_score: 90,
      night_events: { "1": [WINTER_TS] },
    };
    const out = addReadableNightEvents(input);

    expect(out.timezone).toBe("UTC");
    expect(out.sleep_score).toBe(90);
    expect(input.night_events["1"]).toEqual([WINTER_TS]);
    expect(out).not.toBe(input);
  });

  test("returns input unchanged when night_events is missing or falsy", () => {
    const noEvents = { timezone: "UTC", startdate: WINTER_TS };
    expect(addReadableNightEvents(noEvents)).toBe(noEvents);
    expect(addReadableNightEvents(null)).toBe(null);
    expect(addReadableNightEvents(undefined)).toBe(undefined);
    expect(addReadableNightEvents({ night_events: null })).toEqual({
      night_events: null,
    });
  });

  test("does NOT touch top-level timestamp fields — that is addReadableTimestamps' job", () => {
    const out = addReadableNightEvents({
      timezone: "Europe/Paris",
      startdate: WINTER_TS,
      night_events: { "1": [WINTER_TS] },
    });

    expect(out.startdate).toBe(WINTER_TS);
  });

  // KNOWN GAP: only array values are copied into the rebuilt night_events
  // object, so any non-array entry is silently dropped rather than preserved.
  test("KNOWN GAP: non-array night_events entries are dropped", () => {
    const out = addReadableNightEvents({
      night_events: { "1": [WINTER_TS], "2": WINTER_TS, "3": "oops" },
    });

    expect(Object.keys(out.night_events)).toEqual(["1"]);
    expect(out.night_events["2"]).toBeUndefined();
  });

  test("empty night_events object stays empty", () => {
    const out = addReadableNightEvents({ night_events: {} });
    expect(out.night_events).toEqual({});
  });
});

describe("round trip", () => {
  test.each(["2025-11-17", "2024-02-29", "1970-01-01", "2000-01-01", "2099-12-31"])(
    "dateToUnixTimestamp -> formatTimestamp preserves the calendar date (%s)",
    (dateString) => {
      const iso = formatTimestamp(dateToUnixTimestamp(dateString));
      expect(iso).toBe(`${dateString}T00:00:00.000Z`);
      expect(iso.slice(0, 10)).toBe(dateString);
    }
  );

  test("round trip survives addReadableTimestamps with a UTC timezone", () => {
    const out = addReadableTimestamps({
      timezone: "UTC",
      startdate: dateToUnixTimestamp("2025-11-17"),
    });
    expect(out.startdate).toBe("2025-11-17 00:00:00 UTC");
  });
});
