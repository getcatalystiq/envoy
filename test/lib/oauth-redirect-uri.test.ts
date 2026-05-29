import { describe, it, expect, afterEach, vi } from "vitest";

// getEnv() caches its result, so reset modules + stub env before each import to
// exercise isAllowedRedirectUri under different NEXT_PUBLIC_URL / DCR allowlists.
async function loadIsAllowed(nextPublicUrl: string, dcrDomains: string) {
  vi.resetModules();
  vi.stubEnv("NEXT_PUBLIC_URL", nextPublicUrl);
  vi.stubEnv("ALLOWED_DCR_DOMAINS", dcrDomains);
  const mod = await import("@/lib/oauth");
  return mod.isAllowedRedirectUri;
}

describe("isAllowedRedirectUri", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows the app's own origin even when it is NOT in ALLOWED_DCR_DOMAINS (prod login regression)", async () => {
    const isAllowed = await loadIsAllowed(
      "https://envoy-sigma.vercel.app",
      "claude.ai,chatgpt.com",
    );
    expect(isAllowed("https://envoy-sigma.vercel.app/callback")).toBe(true);
  });

  it("allows third-party clients listed in ALLOWED_DCR_DOMAINS (incl. subdomains)", async () => {
    const isAllowed = await loadIsAllowed(
      "https://app.example.com",
      "claude.ai,chatgpt.com",
    );
    expect(isAllowed("https://claude.ai/callback")).toBe(true);
    expect(isAllowed("https://sub.chatgpt.com/cb")).toBe(true);
  });

  it("rejects a host that is neither first-party nor allowlisted", async () => {
    const isAllowed = await loadIsAllowed(
      "https://app.example.com",
      "claude.ai",
    );
    expect(isAllowed("https://attacker.com/callback")).toBe(false);
  });

  it("does not allow a look-alike of the first-party host", async () => {
    const isAllowed = await loadIsAllowed(
      "https://envoy.example.com",
      "claude.ai",
    );
    // exact host match only — not a suffix/substring of the app host
    expect(isAllowed("https://evil-envoy.example.com/callback")).toBe(false);
    expect(isAllowed("https://envoy.example.com.attacker.com/callback")).toBe(false);
  });

  it("rejects malformed URIs", async () => {
    const isAllowed = await loadIsAllowed("https://app.example.com", "claude.ai");
    expect(isAllowed("not-a-url")).toBe(false);
    expect(isAllowed("")).toBe(false);
  });
});
