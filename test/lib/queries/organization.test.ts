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
  getAgentConfig,
  getOrganization,
  updateOrganization,
  getDomainVerificationStatus,
  updateDomainVerification,
  formatDnsRecords,
} from "@/lib/queries/organization";

// test/setup.ts sets process.env.ANTHROPIC_DEFAULT_ENVIRONMENT_ID = "env_test".
const ENV_FALLBACK_ENV = "env_test";

describe("lib/queries/organization", () => {
  beforeEach(() => {
    sqlTemplate.mockReset();
    sqlQuery.mockReset();
  });

  describe("getAgentConfig", () => {
    it("returns {agentId, environmentId, vaultIds} when set", async () => {
      sqlTemplate.mockResolvedValueOnce([
        { agent_id: "agent-42", environment_id: "env-9", vault_id: "vault-7" },
      ]);
      expect(await getAgentConfig("org-1")).toEqual({
        agentId: "agent-42",
        environmentId: "env-9",
        vaultIds: ["vault-7"],
      });
    });

    it("vaultIds is empty when vault_id is unset", async () => {
      sqlTemplate.mockResolvedValueOnce([
        { agent_id: "agent-42", environment_id: "env-9", vault_id: null },
      ]);
      expect((await getAgentConfig("org-1"))?.vaultIds).toEqual([]);
    });

    it("falls back to ANTHROPIC_DEFAULT_ENVIRONMENT_ID when environment_id is null", async () => {
      sqlTemplate.mockResolvedValueOnce([{ agent_id: "agent-42", environment_id: null }]);
      expect(await getAgentConfig("org-1")).toEqual({
        agentId: "agent-42",
        environmentId: ENV_FALLBACK_ENV,
        vaultIds: [],
      });
    });

    it("returns null when agent_id is null", async () => {
      sqlTemplate.mockResolvedValueOnce([{ agent_id: null, environment_id: "env-9" }]);
      expect(await getAgentConfig("org-1")).toBeNull();
    });

    it("returns null when the row is missing", async () => {
      sqlTemplate.mockResolvedValueOnce([]);
      expect(await getAgentConfig("missing")).toBeNull();
    });

    it("scopes the lookup by org id", async () => {
      sqlTemplate.mockResolvedValueOnce([{ agent_id: "a", environment_id: "e" }]);
      await getAgentConfig("org-xyz");
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

    it("selects agent_id + environment_id plainly and no twin_api_key", async () => {
      sqlTemplate.mockResolvedValueOnce([{ id: "org-1" }]);
      await getOrganization("org-1");
      const [strings] = sqlTemplate.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("agent_id");
      expect(text).toContain("environment_id");
      expect(text).toContain("vault_id");
      expect(text).not.toContain("twin_api_key");
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
        agent_id: "agent-7",
        environment_id: "env-7",
      });
      expect(sqlQuery).toHaveBeenCalledOnce();
      const [query, params] = sqlQuery.mock.calls[0];
      expect(query).toContain("UPDATE organizations");
      expect(query).toContain("name = $");
      expect(query).toContain("agent_id = $");
      expect(query).toContain("environment_id = $");
      expect(params[0]).toBe("org-1");
      expect(params).toContain("Updated");
      expect(params).toContain("agent-7");
      expect(params).toContain("env-7");
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
