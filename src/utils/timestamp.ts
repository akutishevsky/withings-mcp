/**
 * Utility functions for converting between Unix timestamps and human-readable datetime strings
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
 * Converts a date string in YYYY-MM-DD format to a Unix timestamp (seconds since epoch)
 * The timestamp represents the start of the day in UTC (00:00:00)
 *
 * @param dateString Date string in YYYY-MM-DD format (e.g., "2025-11-17")
 * @returns Unix timestamp in seconds since epoch
 * @throws Error if the date string is invalid or in wrong format
 */
export function dateToUnixTimestamp(dateString: string): number {
  // Validate format YYYY-MM-DD
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(dateString)) {
    throw new Error(`Invalid date format: ${dateString}. Expected YYYY-MM-DD format.`);
  }

  const [year, month, day] = dateString.split('-').map(Number);

  // Validate date components
  if (month < 1 || month > 12) {
    throw new Error(`Invalid month: ${month}. Must be between 1 and 12.`);
  }

  if (day < 1 || day > 31) {
    throw new Error(`Invalid day: ${day}. Must be between 1 and 31.`);
  }

  // Create UTC date at midnight (00:00:00)
  const date = new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));

  // Check if the date is valid
  if (isNaN(date.getTime())) {
    throw new Error(`Invalid date: ${dateString}`);
  }

  // Return Unix timestamp in seconds
  return Math.floor(date.getTime() / 1000);
}

/**
 * Converts a Unix timestamp to an ISO 8601 datetime string in UTC
 * @param timestamp Unix timestamp (seconds since epoch)
 * @returns ISO 8601 formatted datetime string (e.g., "2024-01-15T10:30:00.000Z")
 */
export function formatTimestamp(timestamp: number): string {
  return new Date(timestamp * 1000).toISOString();
}

/**
 * Converts a Unix timestamp to a localized datetime string in the specified timezone
 * @param timestamp Unix timestamp (seconds since epoch)
 * @param timezone IANA timezone string (e.g., "Europe/Paris", "America/New_York")
 * @returns Localized datetime string (e.g., "2024-01-15 11:30:00 Europe/Paris")
 */
export function formatTimestampWithTimezone(
  timestamp: number,
  timezone: string
): string {
  try {
    const date = new Date(timestamp * 1000);

    // Format the date in the specified timezone
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const dateParts: Record<string, string> = {};

    for (const part of parts) {
      if (part.type !== "literal") {
        dateParts[part.type] = part.value;
      }
    }

    // Build formatted string: YYYY-MM-DD HH:MM:SS timezone
    return `${dateParts.year}-${dateParts.month}-${dateParts.day} ${dateParts.hour}:${dateParts.minute}:${dateParts.second} ${timezone}`;
  } catch (error) {
    // If timezone is invalid or conversion fails, fall back to UTC
    return formatTimestamp(timestamp);
  }
}

/**
 * Recursively processes an object and converts Unix timestamp fields to
 * human-readable datetime strings. If a timezone field is present in the
 * same object, timestamps are converted to that timezone. Otherwise, UTC is used.
 *
 * For each timestamp field (e.g., "startdate"), the Unix timestamp is replaced
 * with a localized datetime string (e.g., "2024-01-15 11:30:00 Europe/Paris")
 * or UTC ISO 8601 string if no timezone is available.
 *
 * @param obj The object to process (can be nested)
 * @returns The processed object with timestamps replaced by readable datetime strings
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

    // First pass: collect timezone if present
    let timezone: string | undefined;
    if (typeof obj.timezone === "string" && obj.timezone.length > 0) {
      timezone = obj.timezone;
    }

    // Second pass: process all fields
    for (const [key, value] of Object.entries(obj)) {
      // Check if this is a timestamp field
      if (
        TIMESTAMP_FIELDS.includes(key) &&
        typeof value === "number" &&
        value > 0
      ) {
        // Replace timestamp with localized datetime string
        if (timezone) {
          processed[key] = formatTimestampWithTimezone(value, timezone);
        } else {
          processed[key] = formatTimestamp(value);
        }
      } else {
        // Recursively process nested objects/arrays
        processed[key] = addReadableTimestamps(value);
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
 * Replaces timestamp values with localized datetime strings.
 *
 * @param sleepData The sleep summary object containing night_events
 * @returns Processed object with night_events timestamps converted to datetime strings
 */
export function addReadableNightEvents(sleepData: any): any {
  if (!sleepData || !sleepData.night_events) {
    return sleepData;
  }

  // Check if timezone is available in sleep data
  const timezone =
    typeof sleepData.timezone === "string" && sleepData.timezone.length > 0
      ? sleepData.timezone
      : undefined;

  const processedNightEvents: any = {};

  for (const [eventType, timestamps] of Object.entries(
    sleepData.night_events
  )) {
    if (Array.isArray(timestamps)) {
      processedNightEvents[eventType] = timestamps.map((ts: number) =>
        timezone ? formatTimestampWithTimezone(ts, timezone) : formatTimestamp(ts)
      );
    }
  }

  return {
    ...sleepData,
    night_events: processedNightEvents,
  };
}
