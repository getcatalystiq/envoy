import { describe, it, expect, vi, beforeEach } from "vitest";

// One file covering happy path + auth gate for the major REST resources.

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/queries/targets", () => ({
  getAll: vi.fn(() => []),
  getById: vi.fn(),
  getByEmail: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteTarget: vi.fn(),
  count: vi.fn(() => 0),
}));

vi.mock("@/lib/queries/campaigns", () => ({
  getAll: vi.fn(() => []),
  getById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteCampaign: vi.fn(),
}));

vi.mock("@/lib/queries/outbox", () => ({
  getAll: vi.fn(() => []),
  getById: vi.fn(),
  count: vi.fn(() => 0),
  create: vi.fn(),
}));

vi.mock("@/lib/queries/segments", () => ({
  getAll: vi.fn(() => []),
  create: vi.fn(),
  getUsage: vi.fn(),
}));

vi.mock("@/lib/queries/sequences", () => ({
  autoEnrollInDefaultSequences: vi.fn(),
  getAll: vi.fn(() => []),
}));

vi.mock("@/lib/queries/target-types", () => ({
  getAll: vi.fn(() => []),
  create: vi.fn(),
}));

vi.mock("@/lib/queries/analytics", () => ({
  getAnalytics: vi.fn(() => ({ total: 0 })),
}));

vi.mock("@/lib/queries/organization", () => ({
  getOrganization: vi.fn(),
  updateOrganization: vi.fn(),
  getTwinAgentId: vi.fn(),
}));

import { requireAdmin } from "@/lib/admin-auth";
import * as targets from "@/lib/queries/targets";
import * as campaigns from "@/lib/queries/campaigns";
import * as outbox from "@/lib/queries/outbox";

import { GET as targetsGET, POST as targetsPOST } from "@/app/api/v1/targets/route";
import { GET as campaignsGET, POST as campaignsPOST } from "@/app/api/v1/campaigns/route";
import { GET as outboxGET } from "@/app/api/v1/outbox/route";

const requireAdminMock = requireAdmin as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({
    userId: "u",
    tenantId: "org-1",
    scope: "admin",
  });
});

describe("/api/v1/targets", () => {
  it("GET requires auth", async () => {
    requireAdminMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const res = await targetsGET(new Request("http://x/api/v1/targets"));
    expect(res.status).toBe(401);
  });

  it("GET returns paginated items + total", async () => {
    (targets.getAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "t1", email: "a@b.com" },
    ]);
    (targets.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    const res = await targetsGET(new Request("http://x/api/v1/targets"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
  });

  it("GET forwards filter params", async () => {
    (targets.getAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (targets.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
    await targetsGET(
      new Request("http://x/api/v1/targets?status=active&lifecycle_stage=2&limit=50&offset=10"),
    );
    expect(targets.getAll).toHaveBeenCalledWith(
      "org-1",
      expect.objectContaining({
        status: "active",
        lifecycleStage: 2,
        limit: 50,
        offset: 10,
      }),
    );
  });

  it("GET clamps limit between 1 and 1000", async () => {
    (targets.getAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce([]);
    (targets.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(0);
    await targetsGET(new Request("http://x/api/v1/targets?limit=100000"));
    const opts = (targets.getAll as ReturnType<typeof vi.fn>).mock.calls[0][1];
    expect(opts.limit).toBe(1000);
  });

  it("POST requires email", async () => {
    const res = await targetsPOST(
      new Request("http://x/api/v1/targets", {
        method: "POST",
        body: JSON.stringify({ first_name: "X" }),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST returns 409 on duplicate email", async () => {
    (targets.getByEmail as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "existing" });
    const res = await targetsPOST(
      new Request("http://x/api/v1/targets", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.com" }),
      }),
    );
    expect(res.status).toBe(409);
  });

  it("POST creates a new target", async () => {
    (targets.getByEmail as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (targets.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "t1",
      email: "a@b.com",
    });
    const res = await targetsPOST(
      new Request("http://x/api/v1/targets", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.com", first_name: "X" }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("/api/v1/campaigns", () => {
  it("GET requires auth", async () => {
    requireAdminMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const res = await campaignsGET(new Request("http://x/api/v1/campaigns"));
    expect(res.status).toBe(401);
  });

  it("GET returns campaigns scoped by org", async () => {
    (campaigns.getAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "c1", name: "C1" },
    ]);
    const res = await campaignsGET(new Request("http://x/api/v1/campaigns"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(campaigns.getAll).toHaveBeenCalledWith(
      "org-1",
      expect.any(Object),
    );
  });

  it("POST requires name", async () => {
    const res = await campaignsPOST(
      new Request("http://x/api/v1/campaigns", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("POST creates campaign", async () => {
    (campaigns.create as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      id: "c1",
      name: "Q1",
    });
    const res = await campaignsPOST(
      new Request("http://x/api/v1/campaigns", {
        method: "POST",
        body: JSON.stringify({ name: "Q1" }),
      }),
    );
    expect(res.status).toBe(201);
  });
});

describe("/api/v1/outbox", () => {
  it("GET requires auth", async () => {
    requireAdminMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const res = await outboxGET(new Request("http://x/api/v1/outbox"));
    expect(res.status).toBe(401);
  });

  it("GET returns paginated items scoped by org", async () => {
    (outbox.getAll as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "o1", subject: "S" },
    ]);
    (outbox.count as ReturnType<typeof vi.fn>).mockResolvedValueOnce(1);
    const res = await outboxGET(new Request("http://x/api/v1/outbox"));
    const body = await res.json();
    expect(body.items).toHaveLength(1);
    expect(body.total).toBe(1);
    expect(outbox.getAll).toHaveBeenCalledWith(
      "org-1",
      expect.any(Object),
    );
  });
});
