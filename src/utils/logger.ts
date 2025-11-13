import pino from "pino";

/**
 * Privacy-Safe Logger Configuration
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

export const logger = pino({
  level: process.env.LOG_LEVEL || "info",

  // Redact sensitive fields
  redact: {
    paths: redactedFields,
    censor: "[REDACTED]",
  },

  // Use plain JSON output for both development and production
  // This works with Deno Deploy and is easily parseable
  formatters: {
    level: (label) => {
      return { level: label };
    },
  },
});

/**
 * Create a child logger with additional context
 * @param context - Context object (e.g., { component: "oauth" })
 */
export function createLogger(context: Record<string, any>) {
  return logger.child(context);
}
