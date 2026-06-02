import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/queries/organization", () => ({
  getAgentConfig: vi.fn(),
}));

vi.mock("@/lib/agent-session", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/agent-session")>("@/lib/agent-session");
  return {
    ...actual,
    listAgentSessions: vi.fn(),
    getAgentSessionEvents: vi.fn(),
    getAgentInstructions: vi.fn(),
    updateAgentInstructions: vi.fn(),
  };
});

import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { getAgentConfig } from "@/lib/queries/organization";
import {
  listAgentSessions,
  getAgentSessionEvents,
  getAgentInstructions,
  updateAgentInstructions,
  AgentError,
} from "@/lib/agent-session";

import { GET as sessionsGET } from "@/app/api/v1/agent/sessions/route";
import { GET as sessionDetailGET } from "@/app/api/v1/agent/sessions/[sessionId]/route";
import {
  GET as instructionsGET,
  PUT as instructionsPUT,
} from "@/app/api/v1/agent/instructions/route";
import { GET as twinGoneGET } from "@/app/api/v1/twin/[...path]/route";

const requireAdminMock = requireAdmin as unknown as ReturnType<typeof vi.fn>;
const getAgentConfigMock = getAgentConfig as unknown as ReturnType<typeof vi.fn>;
const listSessionsMock = listAgentSessions as unknown as ReturnType<typeof vi.fn>;
const getEventsMock = getAgentSessionEvents as unknown as ReturnType<typeof vi.fn>;
const getInstructionsMock = getAgentInstructions as unknown as ReturnType<typeof vi.fn>;
const updateInstructionsMock = updateAgentInstructions as unknown as ReturnType<typeof vi.fn>;
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

const req = (url: string, init?: RequestInit) => new Request(url, init);

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ userId: "u1", tenantId: "org-1", scope: "admin" });
  getAgentConfigMock.mockResolvedValue({
    agentId: "agent-1",
    environmentId: "env-1",
    vaultIds: [],
  });
});

describe("withAgent (via /agent/sessions)", () => {
  it("returns 503 when the org has no agent configured", async () => {
    getAgentConfigMock.mockResolvedValueOnce(null);
    const res = await sessionsGET(req("http://x/api/v1/agent/sessions"));
    expect(res.status).toBe(503);
  });
});

describe("GET /agent/sessions", () => {
  it("returns the org agent's sessions", async () => {
    listSessionsMock.mockResolvedValueOnce([{ id: "s1", status: "idle", created_at: "t" }]);
    const res = await sessionsGET(req("http://x/api/v1/agent/sessions?limit=10"));
    expect(res.status).toBe(200);
    expect((await res.json()).sessions).toHaveLength(1);
    expect(listSessionsMock).toHaveBeenCalledWith("agent-1", { limit: 10 });
  });
});

describe("GET /agent/sessions/[sessionId]", () => {
  it("returns the event timeline", async () => {
    getEventsMock.mockResolvedValueOnce([{ type: "agent.message" }]);
    const res = await sessionDetailGET(req("http://x/api/v1/agent/sessions/s1"), {
      params: Promise.resolve({ sessionId: "s1" }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sessionId).toBe("s1");
    expect(body.events).toHaveLength(1);
  });

  it("returns 404 when the session isn't the org agent's (IDOR guard)", async () => {
    getEventsMock.mockRejectedValueOnce(new AgentError("Session not found", 404));
    const res = await sessionDetailGET(req("http://x/api/v1/agent/sessions/sX"), {
      params: Promise.resolve({ sessionId: "sX" }),
    });
    expect(res.status).toBe(404);
  });
});

describe("GET/PUT /agent/instructions", () => {
  it("GET returns the agent system prompt", async () => {
    getInstructionsMock.mockResolvedValueOnce("Be helpful.");
    const res = await instructionsGET(req("http://x/api/v1/agent/instructions"));
    expect(res.status).toBe(200);
    expect((await res.json()).instructions).toBe("Be helpful.");
  });

  it("PUT updates the prompt and writes an audit row with user_id + org", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await instructionsPUT(
      req("http://x/api/v1/agent/instructions", {
        method: "PUT",
        body: JSON.stringify({ content: "New prompt" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(updateInstructionsMock).toHaveBeenCalledWith("agent-1", "New prompt");
    // audit insert ran with the auth user/org bound
    const [, ...vals] = sqlMock.mock.calls[0];
    expect(vals).toContain("org-1");
    expect(vals).toContain("u1");
    expect(vals).toContain("New prompt");
  });

  it("PUT returns 400 on empty content", async () => {
    const res = await instructionsPUT(
      req("http://x/api/v1/agent/instructions", {
        method: "PUT",
        body: JSON.stringify({ content: "  " }),
      }),
    );
    expect(res.status).toBe(400);
    expect(updateInstructionsMock).not.toHaveBeenCalled();
  });
});

describe("deprecated /api/v1/twin/* catch-all", () => {
  it("returns 410 with a problem+json pointer", async () => {
    const res = await twinGoneGET();
    expect(res.status).toBe(410);
    expect(res.headers.get("Content-Type")).toBe("application/problem+json");
    expect((await res.json()).detail).toContain("/api/v1/agent/*");
  });
});
