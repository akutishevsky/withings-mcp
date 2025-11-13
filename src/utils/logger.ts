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

    const logEntry = {
      level,
      time: new Date().toISOString(),
      msg: message,
      ...this.context,
      ...(data ? { data: this.redact(data) } : {}),
    };

    const output = JSON.stringify(logEntry);

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
