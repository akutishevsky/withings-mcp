/**
 * Privacy-Safe Custom Logger
 *
 * This logger is configured for a PUBLIC repository and follows strict privacy guidelines:
 * - NO tokens, access codes, or authentication credentials are logged
 * - NO user IDs, email addresses, or personal information
 * - NO API request/response payloads containing sensitive data
 * - ONLY operational events, errors, and minimal diagnostic information
 *
 * Log Levels:
 * - error: Critical failures requiring attention
 * - warn: Non-critical issues or deprecations
 * - info: Important operational events (connections, disconnections)
 * - debug: Detailed diagnostic information (disabled in production)
 */

const redactedFields = [
  // Authentication
  "token",
  "access_token",
  "refresh_token",
  "accessToken",
  "refreshToken",
  "bearer",
  "authorization",
  "Authorization",

  // OAuth
  "code",
  "auth_code",
  "authCode",
  "client_secret",
  "clientSecret",
  "code_verifier",
  "codeVerifier",
  "code_challenge",
  "codeChallenge",

  // User data
  "userid",
  "userId",
  "user_id",
  "email",
  "password",

  // Session
  "sessionId",
  "session_id",
  "state",

  // API keys
  "apiKey",
  "api_key",
  "secret",
];

const LOG_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
} as const;

type LogLevel = keyof typeof LOG_LEVELS;

class Logger {
  private level: number;
  private context: Record<string, any>;

  constructor(context: Record<string, any> = {}) {
    const envLevel = (process.env.LOG_LEVEL || "info").toLowerCase() as LogLevel;
    this.level = LOG_LEVELS[envLevel] || LOG_LEVELS.info;
    this.context = context;
  }

  private redact(obj: any): any {
    if (typeof obj !== "object" || obj === null) {
      return obj;
    }

    if (Array.isArray(obj)) {
      return obj.map((item) => this.redact(item));
    }

    const redacted: any = {};
    for (const [key, value] of Object.entries(obj)) {
      if (redactedFields.includes(key)) {
        redacted[key] = "[REDACTED]";
      } else if (typeof value === "object" && value !== null) {
        redacted[key] = this.redact(value);
      } else {
        redacted[key] = value;
      }
    }
    return redacted;
  }

  private log(level: LogLevel, message: string, data?: any) {
    if (LOG_LEVELS[level] < this.level) {
      return;
    }

    // Format: INFO [component] message {data}
    const levelStr = level.toUpperCase().padEnd(5);
    const component = this.context.component ? `[${this.context.component}] ` : '';

    let output = `${levelStr} ${component}${message}`;

    if (data) {
      const redactedData = this.redact(data);
      output += ` ${JSON.stringify(redactedData)}`;
    }

    switch (level) {
      case "error":
        console.error(output);
        break;
      case "warn":
        console.warn(output);
        break;
      default:
        console.log(output);
    }
  }

  trace(message: string, data?: any) {
    this.log("trace", message, data);
  }

  debug(message: string, data?: any) {
    this.log("debug", message, data);
  }

  info(message: string, data?: any) {
    this.log("info", message, data);
  }

  warn(message: string, data?: any) {
    this.log("warn", message, data);
  }

  error(message: string, data?: any) {
    this.log("error", message, data);
  }

  child(context: Record<string, any>) {
    return new Logger({ ...this.context, ...context });
  }
}

export const logger = new Logger();

/**
 * Create a child logger with additional context
 * @param context - Context object (e.g., { component: "oauth" })
 */
export function createLogger(context: Record<string, any>) {
  return logger.child(context);
}

/**
 * Calculate the number of days between two dates.
 * Used for analytics to log date range span without exposing actual dates.
 * @param startDate - Start date in YYYY-MM-DD format
 * @param endDate - End date in YYYY-MM-DD format
 * @returns Number of days between dates, or undefined if dates are invalid/missing
 */
export function calculateDateRangeDays(
  startDate?: string,
  endDate?: string
): number | undefined {
  if (!startDate || !endDate) {
    return undefined;
  }

  // Validate YYYY-MM-DD format
  const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
  if (!dateRegex.test(startDate) || !dateRegex.test(endDate)) {
    return undefined;
  }

  const start = new Date(startDate);
  const end = new Date(endDate);

  // Check for invalid dates
  if (isNaN(start.getTime()) || isNaN(end.getTime())) {
    return undefined;
  }

  const diffMs = end.getTime() - start.getTime();
  const diffDays = Math.ceil(diffMs / (1000 * 60 * 60 * 24));

  return diffDays >= 0 ? diffDays : undefined;
}

/**
 * Categorize errors into privacy-safe categories for analytics.
 * Maps error messages to generic categories without exposing sensitive details.
 * @param error - The error to categorize
 * @returns A privacy-safe error category string
 */
export function categorizeError(error: unknown): string {
  if (!(error instanceof Error)) {
    return "unknown";
  }

  const message = error.message.toLowerCase();

  // Authentication/token issues
  if (
    message.includes("token") ||
    message.includes("unauthorized") ||
    message.includes("401") ||
    message.includes("expired") ||
    message.includes("invalid access")
  ) {
    return "auth_expired";
  }

  // Rate limiting
  if (
    message.includes("rate limit") ||
    message.includes("too many") ||
    message.includes("429")
  ) {
    return "rate_limited";
  }

  // Date format issues
  if (
    message.includes("date") ||
    message.includes("yyyy-mm-dd") ||
    message.includes("invalid format")
  ) {
    return "invalid_date_format";
  }

  // Missing parameters
  if (
    message.includes("required") ||
    message.includes("missing") ||
    message.includes("must provide")
  ) {
    return "missing_required_param";
  }

  // Withings API errors
  if (
    message.includes("withings") ||
    message.includes("api error") ||
    message.includes("status")
  ) {
    return "withings_api_error";
  }

  // Network errors
  if (
    message.includes("network") ||
    message.includes("timeout") ||
    message.includes("econnrefused") ||
    message.includes("fetch") ||
    message.includes("connection")
  ) {
    return "network_error";
  }

  return "unknown";
}
