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
    expect(env.ANTHROPIC_API_KEY).toBe("test-anthropic-key");
    expect(env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID).toBe("env_test");
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

  it("rejects missing ANTHROPIC_API_KEY", async () => {
    const orig = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/ANTHROPIC_API_KEY/);
    process.env.ANTHROPIC_API_KEY = orig;
  });

  it("requires ANTHROPIC_DEFAULT_ENVIRONMENT_ID outside dev (superRefine)", async () => {
    const origDefault = process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID;
    const origEnv = process.env.ENVIRONMENT;
    delete process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID;
    process.env.ENVIRONMENT = "prod";
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/ANTHROPIC_DEFAULT_ENVIRONMENT_ID/);
    if (origDefault !== undefined) process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID = origDefault;
    process.env.ENVIRONMENT = origEnv;
  });

  it("allows a missing ANTHROPIC_DEFAULT_ENVIRONMENT_ID in dev mode", async () => {
    const origDefault = process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID;
    delete process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID;
    process.env.ENVIRONMENT = "dev";
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).not.toThrow();
    if (origDefault !== undefined) process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID = origDefault;
  });

  it("caches parsed env across calls (lazy singleton)", async () => {
    const { getEnv } = await import("@/lib/env");
    const a = getEnv();
    const b = getEnv();
    expect(a).toBe(b); // same reference
  });
});
