import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return {
    sql: Object.assign(sql, { query: vi.fn() }),
  };
});

import { sql } from "@/lib/db";
const sqlTemplate = sql as unknown as ReturnType<typeof vi.fn>;
const sqlQuery = (sql as unknown as { query: ReturnType<typeof vi.fn> }).query;

import {
  getTwinAgentId,
  resolveTwinApiKey,
  getOrganization,
  updateOrganization,
  getDomainVerificationStatus,
  updateDomainVerification,
  formatDnsRecords,
} from "@/lib/queries/organization";

// test/setup.ts sets process.env.TWIN_API_KEY = "test-twin-key", so the
// env-var fallback in resolveTwinApiKey resolves to that.
const ENV_FALLBACK_KEY = "test-twin-key";

describe("lib/queries/organization", () => {
  beforeEach(() => {
    sqlTemplate.mockReset();
    sqlQuery.mockReset();
  });

  describe("getTwinAgentId", () => {
    it("returns the agent id when set", async () => {
      sqlTemplate.mockResolvedValueOnce([{ twin_agent_id: "agent-42" }]);
      expect(await getTwinAgentId("org-1")).toBe("agent-42");
    });

    it("returns null when row exists but twin_agent_id is null", async () => {
      sqlTemplate.mockResolvedValueOnce([{ twin_agent_id: null }]);
      expect(await getTwinAgentId("org-1")).toBeNull();
    });

    it("returns null when row missing entirely", async () => {
      sqlTemplate.mockResolvedValueOnce([]);
      expect(await getTwinAgentId("missing")).toBeNull();
    });

    it("coerces the agent id to a string", async () => {
      sqlTemplate.mockResolvedValueOnce([{ twin_agent_id: 12345 }]);
      const result = await getTwinAgentId("org-1");
      expect(result).toBe("12345");
      expect(typeof result).toBe("string");
    });
  });

  describe("resolveTwinApiKey", () => {
    it("returns the per-org key when set (overrides env)", async () => {
      sqlTemplate.mockResolvedValueOnce([{ twin_api_key: "org-specific-key" }]);
      expect(await resolveTwinApiKey("org-1")).toBe("org-specific-key");
    });

    it("falls back to the env var when twin_api_key is null", async () => {
      sqlTemplate.mockResolvedValueOnce([{ twin_api_key: null }]);
      expect(await resolveTwinApiKey("org-1")).toBe(ENV_FALLBACK_KEY);
    });

    it("falls back to the env var when twin_api_key is an empty string", async () => {
      sqlTemplate.mockResolvedValueOnce([{ twin_api_key: "" }]);
      expect(await resolveTwinApiKey("org-1")).toBe(ENV_FALLBACK_KEY);
    });

    it("falls back to the env var when the org row is missing", async () => {
      sqlTemplate.mockResolvedValueOnce([]);
      expect(await resolveTwinApiKey("missing")).toBe(ENV_FALLBACK_KEY);
    });

    it("never throws when no per-org key — always returns a usable string", async () => {
      sqlTemplate.mockResolvedValueOnce([{ twin_api_key: null }]);
      const key = await resolveTwinApiKey("org-1");
      expect(typeof key).toBe("string");
      expect(key.length).toBeGreaterThan(0);
    });

    it("scopes the lookup by org id", async () => {
      sqlTemplate.mockResolvedValueOnce([{ twin_api_key: "k" }]);
      await resolveTwinApiKey("org-xyz");
      const [, ...values] = sqlTemplate.mock.calls[0];
      expect(values).toContain("org-xyz");
    });
  });

  describe("getOrganization", () => {
    it("returns the org row when found", async () => {
      sqlTemplate.mockResolvedValueOnce([{ id: "org-1", name: "Acme" }]);
      const row = await getOrganization("org-1");
      expect(row).toEqual({ id: "org-1", name: "Acme" });
    });

    it("returns null when not found", async () => {
      sqlTemplate.mockResolvedValueOnce([]);
      expect(await getOrganization("missing")).toBeNull();
    });

    it("selects a derived twin_api_key_configured boolean, never the raw key", async () => {
      sqlTemplate.mockResolvedValueOnce([{ id: "org-1" }]);
      await getOrganization("org-1");
      const [strings] = sqlTemplate.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      // The masked boolean is returned...
      expect(text).toContain("AS twin_api_key_configured");
      // ...and the raw secret is never a bare select-list column (it only
      // appears inside the IS NOT NULL / length() guard expression).
      const selectList = text.slice(text.indexOf("SELECT"), text.indexOf("FROM"));
      const bareKeyColumn = /(^|,)\s*twin_api_key\s*(,|$)/m.test(selectList);
      expect(bareKeyColumn).toBe(false);
    });
  });

  describe("updateOrganization", () => {
    it("returns existing org when no fields provided", async () => {
      sqlTemplate.mockResolvedValueOnce([{ id: "org-1", name: "Existing" }]);
      const result = await updateOrganization("org-1", {});
      expect(result?.name).toBe("Existing");
      expect(sqlQuery).not.toHaveBeenCalled();
    });

    it("throws on unknown field key (mass-assignment protection)", async () => {
      await expect(
        updateOrganization("org-1", { secret_internal_field: "x" }),
      ).rejects.toThrow(/Unknown field/);
      expect(sqlQuery).not.toHaveBeenCalled();
    });

    it("updates allowed columns via parameterized query", async () => {
      sqlQuery.mockResolvedValueOnce([{ id: "org-1", name: "Updated" }]);
      const result = await updateOrganization("org-1", {
        name: "Updated",
        twin_agent_id: "agent-7",
      });
      expect(sqlQuery).toHaveBeenCalledOnce();
      const [query, params] = sqlQuery.mock.calls[0];
      expect(query).toContain("UPDATE organizations");
      expect(query).toContain("name = $");
      expect(query).toContain("twin_agent_id = $");
      expect(params[0]).toBe("org-1");
      expect(params).toContain("Updated");
      expect(params).toContain("agent-7");
      expect(result?.name).toBe("Updated");
    });
  });

  describe("getDomainVerificationStatus", () => {
    it("returns null when org missing", async () => {
      sqlTemplate.mockResolvedValueOnce([]);
      expect(await getDomainVerificationStatus("missing")).toBeNull();
    });

    it("returns verification fields", async () => {
      sqlTemplate.mockResolvedValueOnce([
        {
          email_domain: "example.com",
          email_domain_verified: true,
          email_domain_dkim_tokens: ["t1", "t2"],
          ses_tenant_name: "envoy",
          ses_configuration_set: "main",
        },
      ]);
      const row = await getDomainVerificationStatus("org-1");
      expect(row?.email_domain).toBe("example.com");
      expect(row?.email_domain_verified).toBe(true);
    });
  });

  describe("updateDomainVerification", () => {
    it("issues UPDATE call (smoke)", async () => {
      sqlTemplate.mockResolvedValueOnce([]);
      await updateDomainVerification("org-1", true, ["a", "b"], "tenant", "cfg-set");
      expect(sqlTemplate).toHaveBeenCalledOnce();
    });

    it("works without explicit tenant/cfg (null defaults)", async () => {
      sqlTemplate.mockResolvedValueOnce([]);
      await updateDomainVerification("org-1", false, []);
      expect(sqlTemplate).toHaveBeenCalledOnce();
    });
  });

  describe("formatDnsRecords", () => {
    it("returns DKIM + MX + SPF + DMARC records", () => {
      const records = formatDnsRecords("example.com", ["tok1", "tok2"], "us-west-2");
      // 2 DKIM CNAMEs + 1 MX + 1 SPF + 1 DMARC = 5 records
      expect(records).toHaveLength(5);

      // DKIM
      expect(records[0]).toEqual({
        type: "CNAME",
        name: "tok1._domainkey.example.com",
        value: "tok1.dkim.amazonses.com",
      });

      // MX
      const mx = records.find((r) => r.type === "MX");
      expect(mx).toEqual({
        type: "MX",
        name: "mail.example.com",
        value: "10 feedback-smtp.us-west-2.amazonses.com",
      });

      // SPF
      const spf = records.find((r) => r.type === "TXT" && r.name === "mail.example.com");
      expect(spf?.value).toContain("v=spf1");

      // DMARC
      const dmarc = records.find((r) => r.name === "_dmarc.example.com");
      expect(dmarc?.value).toContain("v=DMARC1");
    });

    it("defaults region to us-east-1", () => {
      const records = formatDnsRecords("ex.com", ["t"]);
      const mx = records.find((r) => r.type === "MX");
      expect(mx?.value).toContain("us-east-1");
    });
  });
});
