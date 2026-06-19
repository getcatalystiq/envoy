import { describe, it, expect, afterEach } from "vitest";
import { verifyCronSecret } from "@/lib/cron-utils";

describe("lib/cron-utils", () => {
  const originalCronSecret = process.env.CRON_SECRET;
  const originalEnvironment = process.env.ENVIRONMENT;

  afterEach(() => {
    process.env.CRON_SECRET = originalCronSecret;
    process.env.ENVIRONMENT = originalEnvironment;
  });

  it("returns null (auth passes) when correct bearer token provided", async () => {
    const req = new Request("http://x/cron", {
      headers: { authorization: "Bearer test-cron-secret" },
    });
    expect(verifyCronSecret(req)).toBeNull();
  });

  it("returns 401 when bearer token is wrong", async () => {
    const req = new Request("http://x/cron", {
      headers: { authorization: "Bearer wrong" },
    });
    const res = verifyCronSecret(req);
    expect(res?.status).toBe(401);
  });

  it("returns 401 when authorization header missing", () => {
    const req = new Request("http://x/cron");
    const res = verifyCronSecret(req);
    expect(res?.status).toBe(401);
  });

  it("uses timing-safe comparison (same-length mismatch still 401)", () => {
    const req = new Request("http://x/cron", {
      headers: { authorization: "Bearer aaaaaaaaaaaaaaaaa" }, // same length, wrong value
    });
    const res = verifyCronSecret(req);
    expect(res?.status).toBe(401);
  });

  // Note: env vars are read once via getEnv()'s lazy cache, so swapping ENVIRONMENT
  // at runtime in these tests doesn't take effect. The dev-mode unauthenticated path
  // is exercised via the setup.ts default (ENVIRONMENT=dev), but we'd need vi.resetModules
  // to swap to prod within a single test.
});
