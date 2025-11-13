/**
 * Utility functions for converting Unix timestamps to human-readable datetime strings
 */

/**
 * List of field names that contain Unix timestamps in Withings API responses
 */
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

/**
 * Converts a Unix timestamp to an ISO 8601 datetime string with timezone
 * @param timestamp Unix timestamp (seconds since epoch)
 * @returns ISO 8601 formatted datetime string (e.g., "2024-01-15T10:30:00.000Z")
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Recursively processes an object and adds human-readable datetime fields
 * for all Unix timestamp fields. Original timestamp values are preserved.
 *
 * For each timestamp field (e.g., "startdate"), adds a corresponding
 * field with "_readable" suffix (e.g., "startdate_readable") containing
 * the ISO 8601 formatted datetime string.
 *
 * @param obj The object to process (can be nested)
 * @returns The processed object with added readable datetime fields
 */
export function addReadableTimestamps(obj: any): any {
  if (obj === null || obj === undefined) {
    return obj;
  }

  // Handle arrays
  if (Array.isArray(obj)) {
    return obj.map((item) => addReadableTimestamps(item));
  }

  // Handle objects
  if (typeof obj === "object") {
    const processed: any = {};

    for (const [key, value] of Object.entries(obj)) {
      // Keep original value
      processed[key] = addReadableTimestamps(value);

      // Add readable datetime field if this is a timestamp field
      if (
        TIMESTAMP_FIELDS.includes(key) &&
        typeof value === "number" &&
        value > 0
      ) {
        processed[`${key}_readable`] = formatTimestamp(value);
      }
    }

    return processed;
  }

  // Return primitive values as-is
  return obj;
}

/**
 * Special handling for night_events field in sleep data which contains
 * a dictionary where keys are event types and values are timestamp arrays.
 * Adds a "_readable" version with ISO datetime strings.
 *
 * @param nightEvents The night_events object from sleep summary
 * @returns Processed object with night_events_readable added
 */
export function addReadableNightEvents(sleepData: any): any {
  if (!sleepData || !sleepData.night_events) {
    return sleepData;
  }

  const nightEventsReadable: any = {};

  for (const [eventType, timestamps] of Object.entries(
    sleepData.night_events
  )) {
    if (Array.isArray(timestamps)) {
      nightEventsReadable[eventType] = timestamps.map((ts: number) =>
        formatTimestamp(ts)
      );
    }
  }

  return {
    ...sleepData,
    night_events_readable: nightEventsReadable,
  };
}
