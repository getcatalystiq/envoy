import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock everything at the route boundary: lib/db (audit insert), lib/twin (REST
// client), lib/queries/organization (agent + key resolution), lib/admin-auth.

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/queries/organization", () => ({
  getTwinAgentId: vi.fn(),
  resolveTwinApiKey: vi.fn(),
}));

vi.mock("@/lib/twin", async () => {
  const actual = await vi.importActual<typeof import("@/lib/twin")>("@/lib/twin");
  return {
    ...actual,
    listRuns: vi.fn(),
    getRun: vi.fn(),
    listRunEvents: vi.fn(),
    assertRunBelongsToAgent: vi.fn(),
    getInstructions: vi.fn(),
    updateInstructions: vi.fn(),
  };
});

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: (r: unknown) => r instanceof Response,
}));

import { getTwinAgentId, resolveTwinApiKey } from "@/lib/queries/organization";
import * as twin from "@/lib/twin";
import { TwinError } from "@/lib/twin";
import { requireAdmin } from "@/lib/admin-auth";
import { sql } from "@/lib/db";

const getAgentMock = getTwinAgentId as unknown as ReturnType<typeof vi.fn>;
const resolveApiKeyMock = resolveTwinApiKey as unknown as ReturnType<typeof vi.fn>;
const requireAdminMock = requireAdmin as unknown as ReturnType<typeof vi.fn>;
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

import * as runsRoute from "@/app/api/v1/twin/runs/route";
import * as runByIdRoute from "@/app/api/v1/twin/runs/[runId]/route";
import * as instructionsRoute from "@/app/api/v1/twin/instructions/route";

function authedRequest(url: string, init: RequestInit = {}) {
  return new Request(url, init);
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({
    userId: "user-1",
    tenantId: "org-1",
    scope: "admin",
  });
  getAgentMock.mockResolvedValue("agent-1");
  resolveApiKeyMock.mockResolvedValue("test-twin-key");
});

// The withTwinAgent gating (auth → agent resolution → TwinError mapping) is
// shared by every Twin route. We exercise it through the surviving
// GET /instructions route since the dedicated /agent route was removed.
describe("withTwinAgent — gating behaviour (via /instructions route)", () => {
  it("forwards 401 from requireAdmin", async () => {
    requireAdminMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "auth" }), { status: 401 }),
    );
    const res = await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    expect(res.status).toBe(401);
  });

  it("returns 503 when org has no twin_agent_id", async () => {
    getAgentMock.mockResolvedValueOnce(null);
    const res = await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error).toContain("not configured");
  });

  it("returns data on success", async () => {
    (twin.getInstructions as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: "hello",
    });
    const res = await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    expect(res.status).toBe(200);
  });

  it("surfaces TwinError status + detail (not blanket 503)", async () => {
    (twin.getInstructions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TwinError("Not Found", 404, "Agent missing"),
    );
    const res = await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.detail).toBe("Agent missing");
  });

  it("clamps out-of-range TwinError statuses to 503", async () => {
    (twin.getInstructions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TwinError("Weird", 999),
    );
    const res = await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    expect(res.status).toBe(503);
  });

  it("remaps a Twin 401 to 502 so a bad TWIN_API_KEY never triggers a logout loop", async () => {
    (twin.getInstructions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TwinError("Unauthorized", 401, "invalid api key"),
    );
    const res = await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    // Must NOT be 401 — the admin UI treats any 401 as an expired session.
    expect(res.status).toBe(502);
    const body = await res.json();
    expect(body.error).toBe("Twin authentication failed");
    expect(body.detail).toBe("invalid api key");
  });

  it("still passes a Twin 403 (plan gate) through unchanged", async () => {
    (twin.getInstructions as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TwinError("Forbidden", 403, "REST API requires a paid plan"),
    );
    const res = await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.detail).toBe("REST API requires a paid plan");
  });

  it("resolves and forwards the per-org apiKey to the Twin client", async () => {
    resolveApiKeyMock.mockResolvedValueOnce("org-specific-key");
    (twin.getInstructions as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: "x",
    });
    await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    expect(twin.getInstructions).toHaveBeenCalledWith("agent-1", {
      apiKey: "org-specific-key",
    });
  });
});

describe("/api/v1/twin/runs GET", () => {
  it("forwards page/page_size/filter_status + apiKey to twin.listRuns", async () => {
    (twin.listRuns as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runs: [],
      total_runs: 0,
      page: 2,
      page_size: 25,
    });
    const res = await runsRoute.GET(
      authedRequest("http://x/api/v1/twin/runs?page=2&page_size=25&filter_status=finished"),
    );
    expect(res.status).toBe(200);
    expect(twin.listRuns).toHaveBeenCalledWith("agent-1", {
      page: 2,
      pageSize: 25,
      filterStatus: "finished",
      apiKey: "test-twin-key",
    });
  });

  it("maps legacy limit/offset to page/page_size", async () => {
    (twin.listRuns as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runs: [],
      total_runs: 0,
      page: 3,
      page_size: 10,
    });
    await runsRoute.GET(
      authedRequest("http://x/api/v1/twin/runs?limit=10&offset=20"),
    );
    // offset=20, limit=10 → page = floor(20/10) + 1 = 3
    expect(twin.listRuns).toHaveBeenCalledWith("agent-1", {
      page: 3,
      pageSize: 10,
      filterStatus: undefined,
      apiKey: "test-twin-key",
    });
  });

  it("rejects page_size > 200", async () => {
    const res = await runsRoute.GET(
      authedRequest("http://x/api/v1/twin/runs?page_size=300"),
    );
    expect(res.status).toBe(400);
  });

  it("rejects invalid filter_status enum value", async () => {
    const res = await runsRoute.GET(
      authedRequest("http://x/api/v1/twin/runs?filter_status=garbage"),
    );
    expect(res.status).toBe(400);
  });

  it("defaults page=1, page_size=50 when nothing provided", async () => {
    (twin.listRuns as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      runs: [],
      total_runs: 0,
      page: 1,
      page_size: 50,
    });
    await runsRoute.GET(authedRequest("http://x/api/v1/twin/runs"));
    expect(twin.listRuns).toHaveBeenCalledWith("agent-1", {
      page: 1,
      pageSize: 50,
      filterStatus: undefined,
      apiKey: "test-twin-key",
    });
  });
});

describe("/api/v1/twin/runs/[runId] GET — flat run + transcript", () => {
  it("asserts ownership then returns { ...run, transcript }", async () => {
    (twin.assertRunBelongsToAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    (twin.getRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      run_id: "r1",
      agent_id: "agent-1",
      is_finished: true,
      status: "finished",
    });
    (twin.listRunEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      events: [{ event_index: 1, recorded_at: "t", event: {} }],
      total_count: 1,
    });
    const res = await runByIdRoute.GET(
      authedRequest("http://x/api/v1/twin/runs/r1"),
      { params: Promise.resolve({ runId: "r1" }) },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.run_id).toBe("r1");
    expect(body.transcript).toHaveLength(1);
    expect(twin.assertRunBelongsToAgent).toHaveBeenCalledWith("agent-1", "r1", {
      apiKey: "test-twin-key",
    });
  });

  it("returns 404 when getRun returns null", async () => {
    (twin.assertRunBelongsToAgent as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    (twin.getRun as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (twin.listRunEvents as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      events: [],
      total_count: 0,
    });
    const res = await runByIdRoute.GET(
      authedRequest("http://x/api/v1/twin/runs/missing"),
      { params: Promise.resolve({ runId: "missing" }) },
    );
    expect(res.status).toBe(404);
  });

  it("404s via TwinError when the run does not belong to the agent", async () => {
    (twin.assertRunBelongsToAgent as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new TwinError("Run not found", 404),
    );
    const res = await runByIdRoute.GET(
      authedRequest("http://x/api/v1/twin/runs/r-rogue"),
      { params: Promise.resolve({ runId: "r-rogue" }) },
    );
    expect(res.status).toBe(404);
    expect(twin.getRun).not.toHaveBeenCalled();
  });
});

describe("/api/v1/twin/instructions", () => {
  it("GET returns instructions object", async () => {
    (twin.getInstructions as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      content: "do thing",
    });
    const res = await instructionsRoute.GET(
      authedRequest("http://x/api/v1/twin/instructions"),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.instructions.content).toBe("do thing");
  });

  it("PUT rejects empty content", async () => {
    const res = await instructionsRoute.PUT(
      new Request("http://x/api/v1/twin/instructions", {
        method: "PUT",
        body: JSON.stringify({ content: "" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("PUT rejects content over 100k", async () => {
    const res = await instructionsRoute.PUT(
      new Request("http://x/api/v1/twin/instructions", {
        method: "PUT",
        body: JSON.stringify({ content: "x".repeat(100_001) }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("PUT calls twin.updateInstructions (with apiKey) + writes audit row", async () => {
    (twin.updateInstructions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    sqlMock.mockResolvedValueOnce([]);
    const res = await instructionsRoute.PUT(
      new Request("http://x/api/v1/twin/instructions", {
        method: "PUT",
        body: JSON.stringify({ content: "new behavior" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(twin.updateInstructions).toHaveBeenCalledWith(
      "agent-1",
      "new behavior",
      { apiKey: "test-twin-key" },
    );
    // Audit row inserted
    expect(sqlMock).toHaveBeenCalledOnce();
    const [strings, ...values] = sqlMock.mock.calls[0];
    const text = (strings as TemplateStringsArray).join("");
    expect(text).toContain("INSERT INTO twin_instruction_updates");
    expect(values).toContain("org-1");
    expect(values).toContain("user-1");
    expect(values).toContain("new behavior");
  });

  it("PUT succeeds even if audit insert fails (best-effort)", async () => {
    (twin.updateInstructions as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    sqlMock.mockRejectedValueOnce(new Error("audit table missing"));
    const consoleErr = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await instructionsRoute.PUT(
      new Request("http://x/api/v1/twin/instructions", {
        method: "PUT",
        body: JSON.stringify({ content: "x" }),
      }),
    );
    expect(res.status).toBe(200); // Twin update already succeeded; audit failure is non-fatal
    expect(consoleErr).toHaveBeenCalled();
    consoleErr.mockRestore();
  });
});
