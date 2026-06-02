import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/admin-auth", () => ({
  requireAdmin: vi.fn(),
  isErrorResponse: (r: unknown) => r instanceof Response,
}));

vi.mock("@/lib/queries/targets", () => ({
  getById: vi.fn(),
}));

vi.mock("@/lib/queries/content", () => ({
  create: vi.fn(),
}));

vi.mock("@/lib/queries/outbox", () => ({
  create: vi.fn(),
}));

vi.mock("@/lib/queries/organization", () => ({
  getAgentConfig: vi.fn(),
}));

vi.mock("@/lib/agent-session", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/agent-session")>("@/lib/agent-session");
  return { ...actual, generateContent: vi.fn() };
});

import { requireAdmin } from "@/lib/admin-auth";
import { getAgentConfig } from "@/lib/queries/organization";
import * as targets from "@/lib/queries/targets";
import * as contentQueries from "@/lib/queries/content";
import * as outboxQueries from "@/lib/queries/outbox";
import { generateContent, AgentError } from "@/lib/agent-session";

import { POST as generatePOST } from "@/app/api/v1/content/generate/route";
import { POST as generateToOutboxPOST } from "@/app/api/v1/content/generate-to-outbox/route";

const requireAdminMock = requireAdmin as unknown as ReturnType<typeof vi.fn>;
const getAgentConfigMock = getAgentConfig as unknown as ReturnType<typeof vi.fn>;
const getByIdMock = targets.getById as unknown as ReturnType<typeof vi.fn>;
const contentCreateMock = contentQueries.create as unknown as ReturnType<typeof vi.fn>;
const outboxCreateMock = outboxQueries.create as unknown as ReturnType<typeof vi.fn>;
const generateContentMock = generateContent as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  requireAdminMock.mockResolvedValue({
    userId: "u",
    tenantId: "org-1",
    scope: "admin",
  });
  getAgentConfigMock.mockResolvedValue({ agentId: "agent-1", environmentId: "env-1" });
});

describe("/api/v1/content/generate POST", () => {
  it("returns 400 when target_id or content_type missing", async () => {
    const res = await generatePOST(
      new Request("http://x/api/v1/content/generate", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 when target not found", async () => {
    getByIdMock.mockResolvedValueOnce(null);
    const res = await generatePOST(
      new Request("http://x/api/v1/content/generate", {
        method: "POST",
        body: JSON.stringify({ target_id: "t1", content_type: "educational" }),
      }),
    );
    expect(res.status).toBe(404);
  });

  it("returns 503 when the org has no agent configured", async () => {
    getAgentConfigMock.mockResolvedValueOnce(null);
    const res = await generatePOST(
      new Request("http://x/api/v1/content/generate", {
        method: "POST",
        body: JSON.stringify({ target_id: "t1", content_type: "educational" }),
      }),
    );
    expect(res.status).toBe(503);
  });

  it("happy path — generates content and creates a content row", async () => {
    getByIdMock.mockResolvedValueOnce({
      id: "t1",
      email: "a@b.com",
      target_type_id: null,
      segment_id: null,
      lifecycle_stage: 0,
    });
    generateContentMock.mockResolvedValueOnce({ subject: "S", body: "B" });
    contentCreateMock.mockResolvedValueOnce({ id: "c1", subject: "S" });
    const res = await generatePOST(
      new Request("http://x/api/v1/content/generate", {
        method: "POST",
        body: JSON.stringify({ target_id: "t1", content_type: "educational" }),
      }),
    );
    expect(res.status).toBe(200);
    expect(generateContent).toHaveBeenCalledWith(
      "agent-1",
      "env-1",
      expect.objectContaining({ email: "a@b.com" }),
      "educational",
    );
    expect(contentCreateMock).toHaveBeenCalled();
  });

  it("surfaces AgentError as a 4xx response (not blanket 500)", async () => {
    getByIdMock.mockResolvedValueOnce({ id: "t1", email: "a@b.com" });
    generateContentMock.mockRejectedValueOnce(new AgentError("Bad", 422, "missing field"));
    const res = await generatePOST(
      new Request("http://x/api/v1/content/generate", {
        method: "POST",
        body: JSON.stringify({ target_id: "t1", content_type: "educational" }),
      }),
    );
    expect(res.status).toBe(422);
    const body = await res.json();
    expect(body.detail).toBe("missing field");
  });
});

describe("/api/v1/content/generate-to-outbox POST", () => {
  it("creates outbox item with confidence score from generation result", async () => {
    getByIdMock.mockResolvedValueOnce({ id: "t1", email: "a@b.com" });
    generateContentMock.mockResolvedValueOnce({
      subject: "S",
      body: "B",
      confidence_score: 0.92,
    });
    outboxCreateMock.mockResolvedValueOnce({ id: "o1", subject: "S" });
    const res = await generateToOutboxPOST(
      new Request("http://x/api/v1/content/generate-to-outbox", {
        method: "POST",
        body: JSON.stringify({
          target_id: "t1",
          content_type: "educational",
          channel: "email",
        }),
      }),
    );
    expect(res.status).toBe(201);
    const [orgId, targetId, channel, body, opts] = outboxCreateMock.mock.calls[0];
    expect(orgId).toBe("org-1");
    expect(targetId).toBe("t1");
    expect(channel).toBe("email");
    expect(body).toBe("B");
    expect(opts.confidenceScore).toBe(0.92);
  });
});
