import { sql } from "@/lib/db";

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Fixed-window rate limiter backed by the `rate_limits` table (serverless-safe —
 * in-memory counters don't survive across function invocations).
 *
 * Atomic upsert: the window resets when `window_start` ages past `windowSeconds`,
 * otherwise the counter increments. A request is allowed while the post-increment
 * count is within `limit`.
 *
 * FAILS OPEN: if the limiter query errors (DB hiccup, missing table during a
 * deploy), we allow the request. A limiter outage must never lock every user out
 * of logging in.
 */
export async function checkRateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
): Promise<RateLimitResult> {
  try {
    const rows = await sql`
      INSERT INTO rate_limits (key, count, window_start)
      VALUES (${key}, 1, NOW())
      ON CONFLICT (key) DO UPDATE SET
        count = CASE
          WHEN rate_limits.window_start < NOW() - make_interval(secs => ${windowSeconds})
          THEN 1
          ELSE rate_limits.count + 1
        END,
        window_start = CASE
          WHEN rate_limits.window_start < NOW() - make_interval(secs => ${windowSeconds})
          THEN NOW()
          ELSE rate_limits.window_start
        END
      RETURNING count
    `;
    const count = Number(rows[0]?.count ?? 0);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: windowSeconds,
    };
  } catch {
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

/**
 * Best-effort client IP from proxy headers (Vercel sets x-forwarded-for). Used
 * only as a rate-limit bucket key, never for authorization.
 */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  return request.headers.get("x-real-ip") || "unknown";
}
