import { describe, it, expect, beforeEach, vi } from "vitest";

describe("lib/env", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("parses a valid environment", async () => {
    const { getEnv } = await import("@/lib/env");
    const env = getEnv();
    expect(env.DATABASE_URL).toContain("postgresql://");
    expect(env.JWT_SECRET.length).toBeGreaterThanOrEqual(32);
    expect(env.TWIN_API_URL).toBe("https://build.twin.so");
    expect(env.TWIN_API_KEY).toBe("test-twin-key");
  });

  it("parses ALLOWED_DCR_DOMAINS as a comma-separated list", async () => {
    const orig = process.env.ALLOWED_DCR_DOMAINS;
    process.env.ALLOWED_DCR_DOMAINS = "foo.com, bar.com ,baz.com";
    const { getEnv } = await import("@/lib/env");
    const env = getEnv();
    expect(env.ALLOWED_DCR_DOMAINS).toEqual(["foo.com", "bar.com", "baz.com"]);
    process.env.ALLOWED_DCR_DOMAINS = orig;
  });

  it("defaults ENVIRONMENT to 'dev' and AWS_SES_REGION to 'us-east-1' when unset", async () => {
    const origEnv = process.env.ENVIRONMENT;
    const origRegion = process.env.AWS_SES_REGION;
    delete process.env.ENVIRONMENT;
    delete process.env.AWS_SES_REGION;
    const { getEnv } = await import("@/lib/env");
    const env = getEnv();
    expect(env.ENVIRONMENT).toBe("dev");
    expect(env.AWS_SES_REGION).toBe("us-east-1");
    if (origEnv !== undefined) process.env.ENVIRONMENT = origEnv;
    if (origRegion !== undefined) process.env.AWS_SES_REGION = origRegion;
  });

  it("rejects JWT_SECRET shorter than 32 characters", async () => {
    const orig = process.env.JWT_SECRET;
    process.env.JWT_SECRET = "tooshort";
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/JWT_SECRET/);
    process.env.JWT_SECRET = orig;
  });

  it("rejects missing TWIN_API_KEY", async () => {
    const orig = process.env.TWIN_API_KEY;
    delete process.env.TWIN_API_KEY;
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/TWIN_API_KEY/);
    process.env.TWIN_API_KEY = orig;
  });

  it("rejects non-https TWIN_API_URL outside dev (superRefine)", async () => {
    const origUrl = process.env.TWIN_API_URL;
    const origEnv = process.env.ENVIRONMENT;
    process.env.TWIN_API_URL = "http://insecure.example.com";
    process.env.ENVIRONMENT = "prod";
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/TWIN_API_URL must use https/);
    process.env.TWIN_API_URL = origUrl;
    process.env.ENVIRONMENT = origEnv;
  });

  it("allows non-https TWIN_API_URL in dev mode", async () => {
    const origUrl = process.env.TWIN_API_URL;
    process.env.TWIN_API_URL = "http://dev-local.example.com";
    process.env.ENVIRONMENT = "dev";
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).not.toThrow();
    process.env.TWIN_API_URL = origUrl;
  });

  it("caches parsed env across calls (lazy singleton)", async () => {
    const { getEnv } = await import("@/lib/env");
    const a = getEnv();
    const b = getEnv();
    expect(a).toBe(b); // same reference
  });
});
