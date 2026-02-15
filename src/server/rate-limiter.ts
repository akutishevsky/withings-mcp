import { Context } from "hono";
import { getSupabaseClient } from "../db/supabase.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "rate-limiter" });

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

class RateLimiter {
  async init(): Promise<void> {
    // No initialization needed - Supabase client is initialized separately
  }

  /**
   * Check if a request should be rate limited.
   * Uses an atomic PostgreSQL function to prevent race conditions.
   */
  async checkLimit(
    identifier: string,
    config: RateLimitConfig
  ): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("check_rate_limit", {
      p_identifier: identifier,
      p_max_requests: config.maxRequests,
      p_window_ms: config.windowMs,
    }).single();

    if (error || !data) {
      // On RPC failure, allow the request but log the error
      logger.error("Rate limit RPC failed, allowing request", { error: error?.message });
      return {
        allowed: true,
        remaining: config.maxRequests,
        resetTime: Date.now() + config.windowMs,
      };
    }

    const result = data as { allowed: boolean; request_count: number; reset_time: string };
    const resetTime = new Date(result.reset_time).getTime();

    return {
      allowed: result.allowed,
      remaining: Math.max(0, config.maxRequests - result.request_count),
      resetTime,
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
