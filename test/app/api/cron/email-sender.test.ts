import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/cron-utils", () => ({
  verifyCronSecret: vi.fn(() => null),
}));

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

vi.mock("@/lib/queries/system", () => ({
  claimQueuedEmails: vi.fn(),
  markEmailSent: vi.fn(),
  markEmailFailed: vi.fn(),
  unstickSendingEmails: vi.fn(() => 0),
}));

vi.mock("@/lib/queries/outbox", () => ({
  markSent: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock("@/lib/ses", () => ({
  sendEmail: vi.fn(),
}));

import { verifyCronSecret } from "@/lib/cron-utils";
import { claimQueuedEmails } from "@/lib/queries/system";
import { sendEmail } from "@/lib/ses";
import { GET } from "@/app/api/cron/email-sender/route";

const verifyMock = verifyCronSecret as unknown as ReturnType<typeof vi.fn>;
const claimMock = claimQueuedEmails as unknown as ReturnType<typeof vi.fn>;
const sendMock = sendEmail as unknown as ReturnType<typeof vi.fn>;

describe("/api/cron/email-sender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyMock.mockReturnValue(null);
  });

  it("requires cron secret", async () => {
    verifyMock.mockReturnValueOnce(new Response("no", { status: 401 }));
    const res = await GET(new Request("http://x/api/cron/email-sender"));
    expect(res.status).toBe(401);
  });

  it("returns sent=0 / failed=0 when no claimed emails", async () => {
    claimMock.mockResolvedValueOnce([]);
    const res = await GET(new Request("http://x/api/cron/email-sender"));
    const body = await res.json();
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(0);
  });

  it("sends each claimed email via SES and reports counts", async () => {
    claimMock.mockResolvedValueOnce([
      {
        id: "e1",
        email: "a@b.com",
        subject: "S",
        body: "<p>B</p>",
        target_id: "t1",
      },
      {
        id: "e2",
        email: "c@d.com",
        subject: "S2",
        body: "<p>B2</p>",
        target_id: "t2",
      },
    ]);
    sendMock.mockResolvedValue({ success: true, messageId: "ses-id-x" });

    const res = await GET(new Request("http://x/api/cron/email-sender"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.sent).toBe(2);
    expect(body.failed).toBe(0);
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("counts SES failures correctly", async () => {
    claimMock.mockResolvedValueOnce([
      { id: "e1", email: "a@b.com", subject: "S", body: "B", target_id: "t1" },
    ]);
    sendMock.mockResolvedValueOnce({ success: false, error: "throttled" });

    const res = await GET(new Request("http://x/api/cron/email-sender"));
    const body = await res.json();
    expect(body.sent).toBe(0);
    expect(body.failed).toBe(1);
  });
});
