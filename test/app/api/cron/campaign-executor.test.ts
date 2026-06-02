import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/cron-utils", () => ({
  verifyCronSecret: vi.fn(() => null),
}));

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/agent-session", () => ({
  generateContent: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn(() => ({ ANTHROPIC_DEFAULT_ENVIRONMENT_ID: "env_default" })),
}));

vi.mock("@/lib/queries/system", () => ({
  claimScheduledCampaigns: vi.fn(),
}));

import { verifyCronSecret } from "@/lib/cron-utils";
import { sql } from "@/lib/db";
import { getEnv } from "@/lib/env";
import { generateContent } from "@/lib/agent-session";
import { claimScheduledCampaigns } from "@/lib/queries/system";
import { GET } from "@/app/api/cron/campaign-executor/route";

const verifyMock = verifyCronSecret as unknown as ReturnType<typeof vi.fn>;
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const sqlQuery = (sql as unknown as { query: ReturnType<typeof vi.fn> }).query;
const claimMock = claimScheduledCampaigns as unknown as ReturnType<typeof vi.fn>;
const generateContentMock = generateContent as unknown as ReturnType<typeof vi.fn>;
const getEnvMock = getEnv as unknown as ReturnType<typeof vi.fn>;

describe("/api/cron/campaign-executor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyMock.mockReturnValue(null);
    getEnvMock.mockReturnValue({ ANTHROPIC_DEFAULT_ENVIRONMENT_ID: "env_default" });
  });

  it("uses the per-org environment_id when present", async () => {
    claimMock.mockResolvedValueOnce([
      { id: "c1", organization_id: "org-1", agent_id: "agent-1", environment_id: "env-org" },
    ]);
    sqlMock.mockResolvedValueOnce([{ id: "t1", email: "a@b.com" }]);
    generateContentMock.mockResolvedValue({ subject: "S", body: "B" });
    sqlQuery.mockResolvedValueOnce({ rows: [] });
    await GET(new Request("http://x/api/cron/campaign-executor"));
    expect(generateContentMock.mock.calls[0][1]).toBe("env-org");
  });

  it("resets a campaign to 'scheduled' (not stranded 'active') when no environment_id resolves", async () => {
    getEnvMock.mockReturnValue({ ANTHROPIC_DEFAULT_ENVIRONMENT_ID: undefined });
    claimMock.mockResolvedValueOnce([
      { id: "c1", organization_id: "org-1", agent_id: "agent-1" }, // no environment_id
    ]);
    const res = await GET(new Request("http://x/api/cron/campaign-executor"));
    const body = await res.json();
    expect(body.campaigns_processed).toBe(0);
    expect(generateContentMock).not.toHaveBeenCalled();
    // The claimed (active) campaign is reset to scheduled so it isn't stranded.
    const resetCall = sqlMock.mock.calls.find((c) => {
      const text = (c[0] as TemplateStringsArray | undefined)?.join?.("") ?? "";
      return text.includes("UPDATE campaigns") && text.includes("'scheduled'");
    });
    expect(resetCall).toBeTruthy();
  });

  it("returns auth error when cron secret invalid", async () => {
    verifyMock.mockReturnValueOnce(new Response("no", { status: 401 }));
    const res = await GET(new Request("http://x/api/cron/campaign-executor"));
    expect(res.status).toBe(401);
  });

  it("returns 200 + 0 processed when no campaigns claimed", async () => {
    claimMock.mockResolvedValueOnce([]);
    const res = await GET(new Request("http://x/api/cron/campaign-executor"));
    const body = await res.json();
    expect(body.campaigns_processed).toBe(0);
  });

  it("processes a claimed campaign — generates per target and bulk INSERTs", async () => {
    claimMock.mockResolvedValueOnce([
      {
        id: "campaign-1",
        organization_id: "org-1",
        agent_id: "agent-1",
      },
    ]);
    // Targets fetch
    sqlMock.mockResolvedValueOnce([
      { id: "t1", email: "a@b.com", first_name: "A" },
      { id: "t2", email: "c@d.com", first_name: "C" },
    ]);
    generateContentMock.mockResolvedValue({ subject: "S", body: "B" });
    sqlQuery.mockResolvedValueOnce({ rows: [] }); // batch INSERT

    const res = await GET(new Request("http://x/api/cron/campaign-executor"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.campaigns_processed).toBe(1);
    expect(body.results[0].result.queued).toBe(2);
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("skips empty subject/body from Twin and increments failed count", async () => {
    claimMock.mockResolvedValueOnce([
      {
        id: "campaign-1",
        organization_id: "org-1",
        agent_id: "agent-1",
      },
    ]);
    sqlMock.mockResolvedValueOnce([
      { id: "t1", email: "a@b.com" },
      { id: "t2", email: "c@d.com" },
    ]);
    generateContentMock
      .mockResolvedValueOnce({ subject: "", body: "" }) // empty → skip
      .mockResolvedValueOnce({ subject: "S", body: "B" }); // valid

    const res = await GET(new Request("http://x/api/cron/campaign-executor"));
    const body = await res.json();
    expect(body.results[0].result.queued).toBe(1);
    expect(body.results[0].result.failed).toBe(1);
  });

  it("counts Twin generateContent rejection as failure (no INSERT)", async () => {
    claimMock.mockResolvedValueOnce([
      { id: "c1", organization_id: "org-1", agent_id: "agent-1" },
    ]);
    sqlMock.mockResolvedValueOnce([{ id: "t1", email: "a@b.com" }]);
    generateContentMock.mockRejectedValueOnce(new Error("Twin down"));

    const res = await GET(new Request("http://x/api/cron/campaign-executor"));
    const body = await res.json();
    expect(body.results[0].result.queued).toBe(0);
    expect(body.results[0].result.failed).toBe(1);
    // No INSERT issued because results is empty
    expect(sqlQuery).not.toHaveBeenCalled();
  });

  it("keyset-paginates: a full page (50) triggers a second fetch and per-page flush", async () => {
    claimMock.mockResolvedValueOnce([
      { id: "c1", organization_id: "org-1", agent_id: "agent-1" },
    ]);
    // BATCH_SIZE = 50. A full first page must trigger a second SELECT.
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: `t${i}`,
      email: `t${i}@x.com`,
    }));
    sqlMock
      .mockResolvedValueOnce(fullPage) // page 1 (== BATCH_SIZE → continue)
      .mockResolvedValueOnce([]); // page 2 (empty → stop)
    generateContentMock.mockResolvedValue({ subject: "S", body: "B" });
    sqlQuery.mockResolvedValue({ rows: [] });

    const res = await GET(new Request("http://x/api/cron/campaign-executor"));
    const body = await res.json();
    expect(body.results[0].result.queued).toBe(50);
    // Two SELECTs proves keyset continuation past the first page.
    expect(sqlMock).toHaveBeenCalledTimes(2);
    // One flush for the non-empty page; the empty page does not flush.
    expect(sqlQuery).toHaveBeenCalledTimes(1);
  });

  it("stops processing further campaigns is bounded; single small campaign completes without timeout flag", async () => {
    claimMock.mockResolvedValueOnce([
      { id: "c1", organization_id: "org-1", agent_id: "agent-1" },
    ]);
    sqlMock.mockResolvedValueOnce([{ id: "t1", email: "a@b.com" }]);
    generateContentMock.mockResolvedValue({ subject: "S", body: "B" });
    sqlQuery.mockResolvedValueOnce({ rows: [] });

    const res = await GET(new Request("http://x/api/cron/campaign-executor"));
    const body = await res.json();
    expect(body.results[0].result.timed_out).toBe(false);
  });
});
