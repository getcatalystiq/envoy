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

// getOrganization is mocked to return a row that already includes the derived
// boolean and never the raw key (matching the real query).
const ORG_ROW = {
  id: "org-1",
  name: "Acme",
  email_domain: null,
  email_domain_verified: false,
  email_domain_dkim_tokens: null,
  email_from_name: "noreply",
  twin_agent_id: "agent-1",
  twin_api_key_configured: true,
};

function patchReq(body: unknown) {
  return new Request("http://x/api/v1/organization", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({
    userId: "u",
    tenantId: "org-1",
    scope: "admin",
  });
  getOrgMock.mockResolvedValue(ORG_ROW);
  updateOrgMock.mockResolvedValue(ORG_ROW);
});

describe("GET /api/v1/organization", () => {
  it("requires admin auth", async () => {
    requireAdminMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const res = await GET(new Request("http://x/api/v1/organization"));
    expect(res.status).toBe(401);
  });

  it("returns the org with twin_api_key_configured and never the raw key", async () => {
    const res = await GET(new Request("http://x/api/v1/organization"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.twin_agent_id).toBe("agent-1");
    expect(body.twin_api_key_configured).toBe(true);
    expect(body.twin_api_key).toBeUndefined(); // raw secret never serialized
  });

  it("404s when the org is missing", async () => {
    getOrgMock.mockResolvedValueOnce(null);
    const res = await GET(new Request("http://x/api/v1/organization"));
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/v1/organization — twin_agent_id", () => {
  it("sets a trimmed twin_agent_id", async () => {
    const res = await PATCH(patchReq({ twin_agent_id: "  agent-42  " }));
    expect(res.status).toBe(200);
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { twin_agent_id: "agent-42" });
  });

  it("treats null as unconfigure", async () => {
    await PATCH(patchReq({ twin_agent_id: null }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { twin_agent_id: null });
  });

  it("treats empty string as unconfigure", async () => {
    await PATCH(patchReq({ twin_agent_id: "" }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { twin_agent_id: null });
  });

  it("rejects a non-string twin_agent_id with 400", async () => {
    const res = await PATCH(patchReq({ twin_agent_id: 12345 }));
    expect(res.status).toBe(400);
    expect(updateOrgMock).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/v1/organization — twin_api_key", () => {
  it("sets a trimmed twin_api_key", async () => {
    const res = await PATCH(patchReq({ twin_api_key: "  tw_live_abc  " }));
    expect(res.status).toBe(200);
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { twin_api_key: "tw_live_abc" });
  });

  it("treats null as unconfigure (fall back to env)", async () => {
    await PATCH(patchReq({ twin_api_key: null }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { twin_api_key: null });
  });

  it("treats empty string as unconfigure", async () => {
    await PATCH(patchReq({ twin_api_key: "" }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", { twin_api_key: null });
  });

  it("rejects a non-string twin_api_key with 400", async () => {
    const res = await PATCH(patchReq({ twin_api_key: { evil: true } }));
    expect(res.status).toBe(400);
    expect(updateOrgMock).not.toHaveBeenCalled();
  });

  it("never echoes the raw key back in the response", async () => {
    const res = await PATCH(patchReq({ twin_api_key: "tw_live_secret" }));
    const body = await res.json();
    expect(body.twin_api_key).toBeUndefined();
    expect(body.twin_api_key_configured).toBe(true);
  });
});

describe("PATCH /api/v1/organization — combined + no-op", () => {
  it("sets agent id and api key together in one update", async () => {
    await PATCH(patchReq({ twin_agent_id: "agent-9", twin_api_key: "k" }));
    expect(updateOrgMock).toHaveBeenCalledWith("org-1", {
      twin_agent_id: "agent-9",
      twin_api_key: "k",
    });
  });

  it("does not call updateOrganization when no recognized fields are sent", async () => {
    const res = await PATCH(patchReq({ unrelated: "x" }));
    expect(res.status).toBe(200);
    expect(updateOrgMock).not.toHaveBeenCalled();
  });

  it("maps an Unknown-field throw from the query layer to 400", async () => {
    updateOrgMock.mockRejectedValueOnce(new Error("Unknown field: bogus"));
    const res = await PATCH(patchReq({ twin_agent_id: "agent-1" }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("Unknown field");
  });
});
