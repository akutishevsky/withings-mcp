import { Context } from "hono";
import { openKv } from "@deno/kv";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "rate-limiter" });

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

class RateLimiter {
  private kv: Awaited<ReturnType<typeof openKv>> | null = null;

  async init() {
    this.kv = await openKv();
  }

  /**
   * Check if a request should be rate limited
   * Returns true if request should be allowed, false if rate limited
   */
  async checkLimit(
    identifier: string,
    config: RateLimitConfig
  ): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    if (!this.kv) throw new Error("KV not initialized");

    const key = ["rate_limit", identifier];
    const now = Date.now();
    const windowStart = now - config.windowMs;

    // Get current request count
    const result = await this.kv.get<{ count: number; resetTime: number }>(key);
    const current = result.value;

    if (!current || current.resetTime < now) {
      // New window or expired window
      const resetTime = now + config.windowMs;
      await this.kv.set(key, { count: 1, resetTime }, { expireIn: config.windowMs });
      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetTime,
      };
    }

    if (current.count >= config.maxRequests) {
      // Rate limit exceeded
      return {
        allowed: false,
        remaining: 0,
        resetTime: current.resetTime,
      };
    }

    // Increment count
    await this.kv.set(
      key,
      { count: current.count + 1, resetTime: current.resetTime },
      { expireIn: current.resetTime - now }
    );

    return {
      allowed: true,
      remaining: config.maxRequests - current.count - 1,
      resetTime: current.resetTime,
    };
  }
}

export const rateLimiter = new RateLimiter();

export async function initRateLimiter() {
  await rateLimiter.init();
}

/**
 * Rate limiting middleware factory
 */
export function rateLimit(config: RateLimitConfig) {
  return async (c: Context, next: () => Promise<void>) => {
    // Use IP address as identifier (fallback to 'unknown' for local development)
    const ip = c.req.header("x-forwarded-for")?.split(",")[0].trim() ||
               c.req.header("x-real-ip") ||
               "unknown";

    const identifier = `${ip}:${c.req.path}`;
    const result = await rateLimiter.checkLimit(identifier, config);

    // Set rate limit headers
    c.header("X-RateLimit-Limit", config.maxRequests.toString());
    c.header("X-RateLimit-Remaining", result.remaining.toString());
    c.header("X-RateLimit-Reset", Math.floor(result.resetTime / 1000).toString());

    if (!result.allowed) {
      const retryAfter = Math.ceil((result.resetTime - Date.now()) / 1000);
      c.header("Retry-After", retryAfter.toString());

      logger.warn("Rate limit exceeded", { ip, path: c.req.path });

      return c.json({
        error: "rate_limit_exceeded",
        error_description: "Too many requests. Please try again later.",
        retry_after: retryAfter,
      }, 429);
    }

    await next();
  };
}
