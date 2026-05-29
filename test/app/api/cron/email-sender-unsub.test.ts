import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock everything at the route boundary so the cron handler runs in isolation:
// cron auth, the system/outbox query modules, and the SES client. We let
// @/lib/email (wrapEmailBody) run for real — it's pure HTML wrapping/sanitizing.

vi.mock("@/lib/cron-utils", () => ({
  verifyCronSecret: vi.fn(() => null),
}));

vi.mock("@/lib/queries/system", () => ({
  claimQueuedEmails: vi.fn(),
  markEmailSent: vi.fn(),
  markEmailFailed: vi.fn(),
  unstickSendingEmails: vi.fn(),
}));

vi.mock("@/lib/queries/outbox", () => ({
  markSent: vi.fn(),
  markFailed: vi.fn(),
}));

vi.mock("@/lib/ses", () => ({
  sendEmail: vi.fn(),
}));

import { GET } from "@/app/api/cron/email-sender/route";
import {
  claimQueuedEmails,
  markEmailSent,
  unstickSendingEmails,
} from "@/lib/queries/system";
import { sendEmail } from "@/lib/ses";

const claimQueuedEmailsMock = claimQueuedEmails as unknown as ReturnType<
  typeof vi.fn
>;
const unstickSendingEmailsMock = unstickSendingEmails as unknown as ReturnType<
  typeof vi.fn
>;
const markEmailSentMock = markEmailSent as unknown as ReturnType<typeof vi.fn>;
const sendEmailMock = sendEmail as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  unstickSendingEmailsMock.mockResolvedValue(0);
  markEmailSentMock.mockResolvedValue(undefined);
  sendEmailMock.mockResolvedValue({ success: true, messageId: "ses-123" });
});

describe("email-sender cron — unsubscribe URL", () => {
  it("builds unsubscribeUrl as NEXT_PUBLIC_URL/unsubscribe/<target_id> with no /api prefix", async () => {
    claimQueuedEmailsMock.mockResolvedValueOnce([
      {
        id: "send-1",
        email: "recipient@example.com",
        subject: "Hello",
        body: "<p>hi there</p>",
        target_id: "target-abc",
      },
    ]);

    const res = await GET(new Request("http://x/api/cron/email-sender"));
    expect(res.status).toBe(200);

    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const args = sendEmailMock.mock.calls[0][0];

    // NEXT_PUBLIC_URL comes from test/setup.ts → http://localhost:3000
    expect(args.unsubscribeUrl).toBe(
      "http://localhost:3000/unsubscribe/target-abc",
    );
    // The route lives at /unsubscribe/[targetId], NOT under /api.
    expect(args.unsubscribeUrl).toMatch(/\/unsubscribe\//);
    expect(args.unsubscribeUrl).not.toContain("/api/unsubscribe");
  });

  it("forwards the recipient + subject and marks the send as sent", async () => {
    claimQueuedEmailsMock.mockResolvedValueOnce([
      {
        id: "send-2",
        email: "person@example.com",
        subject: "Subject line",
        body: "<p>body</p>",
        target_id: "t-99",
      },
    ]);

    const res = await GET(new Request("http://x/api/cron/email-sender"));
    const body = await res.json();

    expect(body).toEqual({ sent: 1, failed: 0, unstuck: 0 });
    const args = sendEmailMock.mock.calls[0][0];
    expect(args.toEmail).toBe("person@example.com");
    expect(args.subject).toBe("Subject line");
    // wrapEmailBody (real) wraps the fragment in a full document.
    expect(args.bodyHtml).toContain("<!DOCTYPE html>");
    expect(args.bodyHtml).toContain("body");
    expect(markEmailSentMock).toHaveBeenCalledWith("send-2", "ses-123");
  });
});
