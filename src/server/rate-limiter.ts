import { Context } from "hono";
import { getSupabaseClient } from "../db/supabase.js";
import { createLogger } from "../utils/logger.js";

const logger = createLogger({ component: "rate-limiter" });

interface RateLimitConfig {
  maxRequests: number;
  windowMs: number;
}

interface RateLimitRow {
  identifier: string;
  request_count: number;
  reset_time: string;
}

class RateLimiter {
  async init(): Promise<void> {
    // No initialization needed - Supabase client is initialized separately
  }

  /**
   * Check if a request should be rate limited
   * Returns true if request should be allowed, false if rate limited
   */
  async checkLimit(
    identifier: string,
    config: RateLimitConfig
  ): Promise<{ allowed: boolean; remaining: number; resetTime: number }> {
    const supabase = getSupabaseClient();
    const now = Date.now();
    const nowIso = new Date(now).toISOString();

    // Get current rate limit record
    const { data } = await supabase
      .from("rate_limits")
      .select("*")
      .eq("identifier", identifier)
      .single();

    const current = data as RateLimitRow | null;

    if (!current || new Date(current.reset_time).getTime() < now) {
      // New window or expired window - create/update record
      const resetTime = now + config.windowMs;
      const resetTimeIso = new Date(resetTime).toISOString();

      await supabase.from("rate_limits").upsert({
        identifier,
        request_count: 1,
        reset_time: resetTimeIso,
        updated_at: nowIso,
      }, {
        onConflict: "identifier",
      });

      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetTime,
      };
    }

    const resetTime = new Date(current.reset_time).getTime();

    if (current.request_count >= config.maxRequests) {
      // Rate limit exceeded
      return {
        allowed: false,
        remaining: 0,
        resetTime,
      };
    }

    // Increment count
    await supabase
      .from("rate_limits")
      .update({
        request_count: current.request_count + 1,
        updated_at: nowIso,
      })
      .eq("identifier", identifier);

    return {
      allowed: true,
      remaining: config.maxRequests - current.request_count - 1,
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
