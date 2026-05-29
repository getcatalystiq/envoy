import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock at the route boundary: lib/admin-auth (auth guard) and
// lib/queries/campaigns (getById ownership check + removeContent mutation).
vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/queries/campaigns", () => ({
  getById: vi.fn(),
  removeContent: vi.fn(),
}));

import { requireAdmin } from "@/lib/admin-auth";
import * as campaigns from "@/lib/queries/campaigns";
import { DELETE } from "@/app/api/v1/campaigns/[id]/content/[contentId]/route";

const requireAdminMock = requireAdmin as unknown as ReturnType<typeof vi.fn>;
const getByIdMock = campaigns.getById as unknown as ReturnType<typeof vi.fn>;
const removeContentMock = campaigns.removeContent as unknown as ReturnType<
  typeof vi.fn
>;

function deleteRequest(id = "camp-1", contentId = "content-1") {
  const request = new Request(
    `http://x/api/v1/campaigns/${id}/content/${contentId}`,
    { method: "DELETE" },
  );
  return DELETE(request, { params: Promise.resolve({ id, contentId }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({
    userId: "user-1",
    tenantId: "org-1",
    scope: "admin",
  });
});

describe("DELETE /api/v1/campaigns/[id]/content/[contentId]", () => {
  it("forwards an error Response from requireAdmin and skips queries", async () => {
    requireAdminMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "auth" }), { status: 401 }),
    );

    const res = await deleteRequest();

    expect(res.status).toBe(401);
    expect(getByIdMock).not.toHaveBeenCalled();
    expect(removeContentMock).not.toHaveBeenCalled();
  });

  it("returns 404 and does NOT call removeContent when the campaign is not found", async () => {
    getByIdMock.mockResolvedValueOnce(null);

    const res = await deleteRequest();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Campaign not found");
    expect(getByIdMock).toHaveBeenCalledWith("org-1", "camp-1");
    expect(removeContentMock).not.toHaveBeenCalled();
  });

  it("returns 204 with an empty body when removeContent succeeds", async () => {
    getByIdMock.mockResolvedValueOnce({ id: "camp-1", name: "Spring" });
    removeContentMock.mockResolvedValueOnce(true);

    const res = await deleteRequest();

    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("calls removeContent with (tenantId, id, contentId)", async () => {
    getByIdMock.mockResolvedValueOnce({ id: "camp-9" });
    removeContentMock.mockResolvedValueOnce(true);

    await deleteRequest("camp-9", "content-42");

    expect(removeContentMock).toHaveBeenCalledWith(
      "org-1",
      "camp-9",
      "content-42",
    );
  });

  it("checks campaign ownership before mutating (getById then removeContent)", async () => {
    const order: string[] = [];
    getByIdMock.mockImplementationOnce(async () => {
      order.push("getById");
      return { id: "camp-1" };
    });
    removeContentMock.mockImplementationOnce(async () => {
      order.push("removeContent");
      return true;
    });

    await deleteRequest();

    expect(order).toEqual(["getById", "removeContent"]);
  });

  it("returns 404 when the content link is not present in the campaign", async () => {
    getByIdMock.mockResolvedValueOnce({ id: "camp-1" });
    removeContentMock.mockResolvedValueOnce(false);

    const res = await deleteRequest();

    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body.error).toBe("Content not found in campaign");
  });
});
