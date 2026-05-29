import { describe, it, expect, afterEach, vi } from "vitest";
import {
  buildRefreshCookie,
  buildClearRefreshCookie,
  readRefreshCookie,
  jsonWithCookie,
} from "@/lib/session-cookie";

describe("session-cookie", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("buildRefreshCookie sets HttpOnly, SameSite=Lax, scoped Path, and Max-Age", () => {
    const c = buildRefreshCookie("tok123", 2592000);
    expect(c).toContain("envoy_rt=tok123");
    expect(c).toContain("HttpOnly");
    expect(c).toContain("SameSite=Lax");
    expect(c).toContain("Path=/api/session");
    expect(c).toContain("Max-Age=2592000");
  });

  it("marks the cookie Secure outside dev, not in dev", () => {
    vi.stubEnv("ENVIRONMENT", "prod");
    expect(buildRefreshCookie("t", 100)).toContain("Secure");
    vi.stubEnv("ENVIRONMENT", "dev");
    expect(buildRefreshCookie("t", 100)).not.toContain("Secure");
  });

  it("buildClearRefreshCookie expires the cookie (Max-Age=0)", () => {
    const c = buildClearRefreshCookie();
    expect(c).toContain("envoy_rt=");
    expect(c).toContain("Max-Age=0");
    expect(c).toContain("Path=/api/session");
    expect(c).toContain("HttpOnly");
  });

  it("readRefreshCookie extracts the value from the Cookie header", () => {
    const req = new Request("http://x/api/session/refresh", {
      headers: { cookie: "other=1; envoy_rt=abc.def; another=2" },
    });
    expect(readRefreshCookie(req)).toBe("abc.def");
  });

  it("readRefreshCookie returns null when absent or empty", () => {
    expect(readRefreshCookie(new Request("http://x"))).toBeNull();
    expect(
      readRefreshCookie(new Request("http://x", { headers: { cookie: "envoy_rt=" } })),
    ).toBeNull();
    expect(
      readRefreshCookie(new Request("http://x", { headers: { cookie: "foo=bar" } })),
    ).toBeNull();
  });

  it("jsonWithCookie sets Set-Cookie and no-store, with the JSON body", async () => {
    const res = jsonWithCookie({ ok: true }, 200, buildClearRefreshCookie());
    expect(res.status).toBe(200);
    expect(res.headers.get("Set-Cookie")).toContain("envoy_rt=");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual({ ok: true });
  });
});
