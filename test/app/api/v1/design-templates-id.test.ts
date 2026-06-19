import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/queries/design-templates", () => ({
  getById: vi.fn(),
  update: vi.fn(),
  deleteTemplate: vi.fn(),
}));

import { requireAdmin } from "@/lib/admin-auth";
import * as designTemplates from "@/lib/queries/design-templates";
import { GET, PATCH, DELETE } from "@/app/api/v1/design-templates/[id]/route";

const requireAdminMock = requireAdmin as unknown as ReturnType<typeof vi.fn>;
const getByIdMock = designTemplates.getById as unknown as ReturnType<typeof vi.fn>;
const updateMock = designTemplates.update as unknown as ReturnType<typeof vi.fn>;
const deleteMock = designTemplates.deleteTemplate as unknown as ReturnType<typeof vi.fn>;

const VALID_ID = "5a623962-770c-4741-a466-6dbbcf2900c4";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({ userId: "u", tenantId: "org-1", scope: "admin" });
});

describe("/api/v1/design-templates/[id] malformed id", () => {
  // The reported bug: GET /api/v1/design-templates/{{unsubscribe_link}} 500'd because
  // a non-uuid path param reached `WHERE id = ${id}::uuid` (Postgres 22P02).
  it("GET returns 404 without touching the DB for a non-uuid id", async () => {
    const res = await GET(new Request("http://x"), ctx("{{unsubscribe_link}}"));
    expect(res.status).toBe(404);
    expect(getByIdMock).not.toHaveBeenCalled();
  });

  it("PATCH returns 404 without touching the DB for a non-uuid id", async () => {
    const res = await PATCH(
      new Request("http://x", { method: "PATCH", body: JSON.stringify({ name: "x" }) }),
      ctx("not-a-uuid"),
    );
    expect(res.status).toBe(404);
    expect(updateMock).not.toHaveBeenCalled();
  });

  it("DELETE returns 404 without touching the DB for a non-uuid id", async () => {
    const res = await DELETE(new Request("http://x", { method: "DELETE" }), ctx("../etc/passwd"));
    expect(res.status).toBe(404);
    expect(deleteMock).not.toHaveBeenCalled();
  });
});

describe("/api/v1/design-templates/[id] valid id", () => {
  it("GET 200 with the template when found", async () => {
    getByIdMock.mockResolvedValue({ id: VALID_ID, name: "T" });
    const res = await GET(new Request("http://x"), ctx(VALID_ID));
    expect(res.status).toBe(200);
    expect(getByIdMock).toHaveBeenCalledWith("org-1", VALID_ID);
    expect(await res.json()).toMatchObject({ id: VALID_ID });
  });

  it("GET 404 when a valid uuid is not found", async () => {
    getByIdMock.mockResolvedValue(null);
    const res = await GET(new Request("http://x"), ctx(VALID_ID));
    expect(res.status).toBe(404);
    expect(getByIdMock).toHaveBeenCalledWith("org-1", VALID_ID);
  });
});
