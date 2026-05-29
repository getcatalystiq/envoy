import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: (r: unknown) => r instanceof Response,
}));

import { sql } from "@/lib/db";
import { requireAdmin } from "@/lib/admin-auth";
import { GET } from "@/app/api/v1/setup/route";

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const requireAdminMock = requireAdmin as unknown as ReturnType<typeof vi.fn>;

describe("/api/v1/setup GET", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireAdminMock.mockResolvedValue({
      userId: "u",
      tenantId: "11111111-1111-4111-8111-111111111111",
      scope: "admin",
    });
  });

  it("requires admin auth", async () => {
    requireAdminMock.mockResolvedValueOnce(new Response("no", { status: 401 }));
    const res = await GET(new Request("http://x/api/v1/setup"));
    expect(res.status).toBe(401);
  });

  it("returns twin_configured=true when twin_agent_id is set", async () => {
    sqlMock.mockResolvedValueOnce([{ twin_agent_id: "agent-1" }]);
    const res = await GET(new Request("http://x/api/v1/setup"));
    const body = await res.json();
    expect(body.twin_configured).toBe(true);
    // Also includes deprecated alias
    expect(body.agentplane_configured).toBe(true);
  });

  it("returns twin_configured=false when no agent configured", async () => {
    sqlMock.mockResolvedValueOnce([{ twin_agent_id: null }]);
    const res = await GET(new Request("http://x/api/v1/setup"));
    const body = await res.json();
    expect(body.twin_configured).toBe(false);
    expect(body.agentplane_configured).toBe(false);
  });

  it("returns twin_configured=false when org row missing", async () => {
    sqlMock.mockResolvedValueOnce([]);
    const res = await GET(new Request("http://x/api/v1/setup"));
    const body = await res.json();
    expect(body.twin_configured).toBe(false);
  });

  it("includes X-Deprecation header for the alias", async () => {
    sqlMock.mockResolvedValueOnce([{ twin_agent_id: "x" }]);
    const res = await GET(new Request("http://x/api/v1/setup"));
    expect(res.headers.get("X-Deprecation")).toContain("agentplane_configured");
  });
});
