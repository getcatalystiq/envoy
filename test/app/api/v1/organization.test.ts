import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/queries/organization", () => ({
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  formatDnsRecords: vi.fn(() => []),
}));

vi.mock("@/lib/ses", () => ({
  verifyDomain: vi.fn(),
}));

import { requireAdmin } from "@/lib/admin-auth";
import * as org from "@/lib/queries/organization";
import { GET, PATCH } from "@/app/api/v1/organization/route";

const requireAdminMock = requireAdmin as unknown as ReturnType<typeof vi.fn>;
const getOrgMock = org.getOrganization as unknown as ReturnType<typeof vi.fn>;
const updateOrgMock = org.updateOrganization as unknown as ReturnType<typeof vi.fn>;

const ORG_ROW = {
  id: "org-1",
  name: "Acme",
  email_domain: null,
  email_domain_verified: false,
  email_domain_dkim_tokens: null,
  email_from_name: "noreply",
  agent_id: "agent-1",
  environment_id: "env-1",
};

function patchReq(body: unknown) {
  return new Request("http://x/api/v1/organization", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ userId: "u", tenantId: "org-1", scope: "admin" });
  getOrgMock.mockResolvedValue(ORG_ROW);
  updateOrgMock.mockResolvedValue(ORG_ROW);
});

describe("GET /api/v1/organization", () => {
  it("requires admin auth", async () => {
    requireAdminMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const res = await GET(new Request("http://x/api/v1/organization"));
    expect(res.status).toBe(401);
  });

  it("returns agent_id + environment_id plainly and no twin_api_key", async () => {
    const res = await GET(new Request("http://x/api/v1/organization"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agent_id).toBe("agent-1");
    expect(body.environment_id).toBe("env-1");
    expect(body.twin_api_key).toBeUndefined();
    expect(body.twin_api_key_configured).toBeUndefined();
  });

  it("404s when the org is missing", async () => {
    getOrgMock.mockResolvedValueOnce(null);
    const res = await GET(new Request("http://x/api/v1/organization"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/v1/organization — agent_id", () => {
  it("sets a trimmed agent_id", async () => {
    const res = await PATCH(patchReq({ agent_id: "  agent-42  " }));
    expect(res.status).toBe(200);
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { agent_id: "agent-42" });
  });

  it("treats null/empty as unconfigure", async () => {
    await PATCH(patchReq({ agent_id: null }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { agent_id: null });
    await PATCH(patchReq({ agent_id: "" }));
    expect(updateOrgMock).toHaveBeenLastCalledWith("org-1", { agent_id: null });
  });

  it("rejects a non-string agent_id with 400", async () => {
    const res = await PATCH(patchReq({ agent_id: 12345 }));
    expect(res.status).toBe(400);
    expect(updateOrgMock).not.toHaveBeenCalled();
  });

  it("maps a UNIQUE(agent_id) violation to 409", async () => {
    updateOrgMock.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    const res = await PATCH(patchReq({ agent_id: "agent-taken" }));
    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/v1/organization — environment_id", () => {
  it("sets a trimmed environment_id", async () => {
    await PATCH(patchReq({ environment_id: "  env-7  " }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { environment_id: "env-7" });
  });

  it("treats null/empty as clearing the override", async () => {
    await PATCH(patchReq({ environment_id: "" }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { environment_id: null });
  });

  it("rejects a non-string environment_id with 400", async () => {
    const res = await PATCH(patchReq({ environment_id: { evil: true } }));
    expect(res.status).toBe(400);
    expect(updateOrgMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/organization — combined + no-op", () => {
  it("sets agent id and environment together in one update", async () => {
    await PATCH(patchReq({ agent_id: "agent-9", environment_id: "env-9" }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", {
      agent_id: "agent-9",
      environment_id: "env-9",
    });
  });

  it("does not call updateOrganization when no recognized fields are sent", async () => {
    const res = await PATCH(patchReq({ unrelated: "x" }));
    expect(res.status).toBe(200);
    expect(updateOrgMock).not.toHaveBeenCalled();
  });

  it("maps an Unknown-field throw from the query layer to 400", async () => {
    updateOrgMock.mockRejectedValueOnce(new Error("Unknown field: bogus"));
    const res = await PATCH(patchReq({ agent_id: "agent-1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unknown field");
  });
});
