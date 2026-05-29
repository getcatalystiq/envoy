import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/webhook-auth", () => ({
  verifyWebhookSecret: vi.fn(),
}));

vi.mock("@/lib/queries/sequences", () => ({
  autoEnrollInDefaultSequences: vi.fn(),
}));

import { sql } from "@/lib/db";
import { verifyWebhookSecret } from "@/lib/webhook-auth";
import { POST } from "@/app/api/webhooks/targets/route";

const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const verifyMock = verifyWebhookSecret as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  verifyMock.mockResolvedValue(null);
});

describe("/api/webhooks/targets POST", () => {
  it("returns 400 when X-Organization-Id header missing", async () => {
    const res = await POST(
      new Request("http://x/api/webhooks/targets", {
        method: "POST",
        body: JSON.stringify({ email: "a@b.com" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("X-Organization-Id");
  });

  it("returns 400 when X-Webhook-Secret header missing", async () => {
    const res = await POST(
      new Request("http://x/api/webhooks/targets", {
        method: "POST",
        headers: { "X-Organization-Id": "org-1" },
        body: JSON.stringify({ email: "a@b.com" }),
      }),
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("X-Webhook-Secret");
  });

  it("returns 401 when webhook secret check fails", async () => {
    verifyMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "bad secret" }), { status: 401 }),
    );
    const res = await POST(
      new Request("http://x/api/webhooks/targets", {
        method: "POST",
        headers: {
          "X-Organization-Id": "org-1",
          "X-Webhook-Secret": "wrong",
        },
        body: JSON.stringify({ email: "a@b.com" }),
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 400 when neither email nor phone provided", async () => {
    const res = await POST(
      new Request("http://x/api/webhooks/targets", {
        method: "POST",
        headers: {
          "X-Organization-Id": "org-1",
          "X-Webhook-Secret": "secret",
        },
        body: JSON.stringify({ first_name: "X" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});
