import { describe, it, expect, vi, beforeEach } from "vitest";

// checkRateLimit issues a single tagged-template `sql` query. We mock @/lib/db
// so the test controls the count it returns (or makes it throw).
vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

import { checkRateLimit, clientIp } from "@/lib/rate-limit";
import { sql } from "@/lib/db";

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  sqlMock.mockReset();
});

describe("checkRateLimit", () => {
  it("allows the request while count is below the limit", async () => {
    sqlMock.mockResolvedValueOnce([{ count: 3 }]);

    const result = await checkRateLimit("ip:1.2.3.4", 5, 60);

    expect(result).toEqual({
      allowed: true,
      remaining: 2, // limit - count = 5 - 3
      retryAfterSeconds: 60,
    });
    expect(sqlMock).toHaveBeenCalledTimes(1);
  });

  it("allows the request when count exactly equals the limit (boundary)", async () => {
    sqlMock.mockResolvedValueOnce([{ count: 5 }]);

    const result = await checkRateLimit("ip:1.2.3.4", 5, 60);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("denies the request once count exceeds the limit", async () => {
    sqlMock.mockResolvedValueOnce([{ count: 6 }]);

    const result = await checkRateLimit("ip:1.2.3.4", 5, 60);

    expect(result.allowed).toBe(false);
    // remaining is clamped at 0, never negative
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(60);
  });

  it("coerces a string count from the driver and clamps remaining at 0", async () => {
    // Neon returns numeric columns as strings; Number() must coerce them.
    sqlMock.mockResolvedValueOnce([{ count: "10" }]);

    const result = await checkRateLimit("ip:1.2.3.4", 5, 30);

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("treats a missing row as count 0 (allowed)", async () => {
    sqlMock.mockResolvedValueOnce([]);

    const result = await checkRateLimit("ip:1.2.3.4", 5, 60);

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(5);
  });

  it("FAILS OPEN (allowed=true) when the limiter query throws", async () => {
    sqlMock.mockRejectedValueOnce(new Error("connection refused"));

    const result = await checkRateLimit("ip:1.2.3.4", 5, 60);

    expect(result).toEqual({
      allowed: true,
      remaining: 5, // falls back to the full limit
      retryAfterSeconds: 0,
    });
  });
});

describe("clientIp", () => {
  it("prefers the first entry of x-forwarded-for", () => {
    const request = new Request("https://example.com", {
      headers: {
        "x-forwarded-for": "203.0.113.7, 70.41.3.18, 150.172.238.178",
        "x-real-ip": "10.0.0.1",
      },
    });

    expect(clientIp(request)).toBe("203.0.113.7");
  });

  it("trims whitespace around the first x-forwarded-for entry", () => {
    const request = new Request("https://example.com", {
      headers: { "x-forwarded-for": "  198.51.100.5  , 10.0.0.2" },
    });

    expect(clientIp(request)).toBe("198.51.100.5");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    const request = new Request("https://example.com", {
      headers: { "x-real-ip": "192.0.2.44" },
    });

    expect(clientIp(request)).toBe("192.0.2.44");
  });

  it("falls back to 'unknown' when no proxy headers are present", () => {
    const request = new Request("https://example.com");

    expect(clientIp(request)).toBe("unknown");
  });
});
