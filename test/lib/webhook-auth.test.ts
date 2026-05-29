import { describe, it, expect, vi, beforeEach } from "vitest";

// vi.mock factory is hoisted — keep state inline.
vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return {
    sql: Object.assign(sql, { query: vi.fn() }),
  };
});

import { sql } from "@/lib/db";
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

import {
  verifyWebhookSecret,
  generateWebhookSecret,
  getOrganizationWebhookSecret,
  setOrganizationWebhookSecret,
} from "@/lib/webhook-auth";

describe("lib/webhook-auth", () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  describe("verifyWebhookSecret", () => {
    it("returns 401 when no secret provided", async () => {
      const res = await verifyWebhookSecret("org-1", "");
      expect(res?.status).toBe(401);
      const body = await res?.json();
      expect(body.error).toContain("Missing X-Webhook-Secret");
    });

    it("returns 404 when organization not found", async () => {
      sqlMock.mockResolvedValueOnce([]);
      const res = await verifyWebhookSecret("missing-org", "some-secret");
      expect(res?.status).toBe(404);
    });

    it("returns 401 when org has no webhook_secret configured", async () => {
      sqlMock.mockResolvedValueOnce([{ webhook_secret: null }]);
      const res = await verifyWebhookSecret("org-1", "some-secret");
      expect(res?.status).toBe(401);
      const body = await res?.json();
      expect(body.error).toContain("not configured");
    });

    it("returns 401 when secret length mismatches", async () => {
      sqlMock.mockResolvedValueOnce([{ webhook_secret: "expected-32-char-secret-aaaaaaaa" }]);
      const res = await verifyWebhookSecret("org-1", "short");
      expect(res?.status).toBe(401);
    });

    it("returns 401 when same-length but wrong value", async () => {
      sqlMock.mockResolvedValueOnce([{ webhook_secret: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" }]);
      const res = await verifyWebhookSecret("org-1", "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
      expect(res?.status).toBe(401);
    });

    it("returns null (passes) when secret matches exactly", async () => {
      sqlMock.mockResolvedValueOnce([{ webhook_secret: "correct-secret-32-chars-abcdefgh" }]);
      const res = await verifyWebhookSecret("org-1", "correct-secret-32-chars-abcdefgh");
      expect(res).toBeNull();
    });
  });

  describe("getOrganizationWebhookSecret", () => {
    it("returns the secret for an existing org", async () => {
      sqlMock.mockResolvedValueOnce([{ webhook_secret: "secret-value" }]);
      expect(await getOrganizationWebhookSecret("org-1")).toBe("secret-value");
    });

    it("returns null when no row found", async () => {
      sqlMock.mockResolvedValueOnce([]);
      expect(await getOrganizationWebhookSecret("missing")).toBeNull();
    });
  });

  describe("setOrganizationWebhookSecret", () => {
    it("issues an UPDATE on organizations", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await setOrganizationWebhookSecret("org-1", "new-secret");
      expect(sqlMock).toHaveBeenCalledOnce();
    });
  });

  describe("generateWebhookSecret", () => {
    it("returns 64-char hex string (32 bytes)", () => {
      const secret = generateWebhookSecret();
      expect(secret).toMatch(/^[a-f0-9]{64}$/);
    });

    it("produces different secrets each call", () => {
      const a = generateWebhookSecret();
      const b = generateWebhookSecret();
      expect(a).not.toBe(b);
    });
  });
});
