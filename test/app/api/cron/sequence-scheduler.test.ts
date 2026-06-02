import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock all dependencies the cron route reaches into.
vi.mock("@/lib/cron-utils", () => ({
  verifyCronSecret: vi.fn(() => null), // auth passes by default
}));

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/agent-session", () => ({
  runAgentJson: vi.fn(),
  harvestAgentSession: vi.fn(() => ({ state: "unavailable" })),
}));

vi.mock("@/lib/block-compiler", () => ({
  compileBuilderContent: vi.fn(() => "<p>compiled</p>"),
}));

vi.mock("@/lib/email", () => ({
  wrapEmailBody: vi.fn((b: string) => `<wrapped>${b}</wrapped>`),
}));

vi.mock("@/lib/personalization", () => ({
  hasPersonalizedBlocks: vi.fn(() => false),
  processPersonalization: vi.fn(),
}));

vi.mock("@/lib/queries/system", () => ({
  getDueEnrollments: vi.fn(),
  resetSkippedEnrollments: vi.fn(),
}));

vi.mock("@/lib/queries/sequences", () => ({
  completeEnrollment: vi.fn(),
  getStepByPosition: vi.fn(),
  getStepContent: vi.fn(),
  recordExecution: vi.fn(),
  advanceEnrollment: vi.fn(),
  setStepExecutionAgentSessionId: vi.fn(),
  getInflightAgentSessionId: vi.fn(() => null),
  clearStepExecutionAgentSessionId: vi.fn(),
}));

vi.mock("@/lib/queries/outbox", () => ({
  create: vi.fn(),
}));

vi.mock("@/lib/template-engine", () => ({
  replaceTemplatesInBlocks: vi.fn((bc: unknown) => bc),
}));

import { verifyCronSecret } from "@/lib/cron-utils";
import { getDueEnrollments } from "@/lib/queries/system";
import { GET } from "@/app/api/cron/sequence-scheduler/route";

const verifyMock = verifyCronSecret as unknown as ReturnType<typeof vi.fn>;
const getEnrollmentsMock = getDueEnrollments as unknown as ReturnType<typeof vi.fn>;

describe("/api/cron/sequence-scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyMock.mockReturnValue(null);
  });

  it("returns the auth response when verifyCronSecret rejects", async () => {
    verifyMock.mockReturnValueOnce(new Response("nope", { status: 401 }));
    const res = await GET(new Request("http://x/api/cron/sequence-scheduler"));
    expect(res.status).toBe(401);
  });

  it("returns 200 with processed=0 when no due enrollments", async () => {
    getEnrollmentsMock.mockResolvedValueOnce([]);
    const res = await GET(new Request("http://x/api/cron/sequence-scheduler"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.processed).toBe(0);
  });
});
