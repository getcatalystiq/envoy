import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/sns-verify", () => ({
  verifySnsMessage: vi.fn(),
  handleSnsSubscriptionConfirmation: vi.fn(),
}));

vi.mock("@/lib/queries/system", () => ({
  updateSendStatus: vi.fn(),
  updateTargetStatusByEmail: vi.fn(),
  recordEngagementEvent: vi.fn(),
  incrementSoftBounce: vi.fn(),
}));

import { verifySnsMessage, handleSnsSubscriptionConfirmation } from "@/lib/sns-verify";
import { POST } from "@/app/api/webhooks/ses/route";

const verifyMock = verifySnsMessage as unknown as ReturnType<typeof vi.fn>;
const handleConfirmMock = handleSnsSubscriptionConfirmation as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
});

describe("/api/webhooks/ses POST", () => {
  it("returns 403 when signature verification fails", async () => {
    verifyMock.mockRejectedValueOnce(new Error("invalid signature"));
    const res = await POST(
      new Request("http://x/api/webhooks/ses", {
        method: "POST",
        body: JSON.stringify({ Type: "Notification" }),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("handles SubscriptionConfirmation by calling subscribe", async () => {
    verifyMock.mockResolvedValueOnce({
      Type: "SubscriptionConfirmation",
      SubscribeURL: "https://sns/confirm",
    });
    handleConfirmMock.mockResolvedValueOnce(undefined);
    const res = await POST(
      new Request("http://x/api/webhooks/ses", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(handleConfirmMock).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });

  it("processes a Notification with bounce event", async () => {
    verifyMock.mockResolvedValueOnce({
      Type: "Notification",
      Message: JSON.stringify({
        notificationType: "Bounce",
        mail: { messageId: "ses-id-1" },
        bounce: {
          bouncedRecipients: [{ emailAddress: "a@b.com" }],
          bounceType: "Permanent",
        },
      }),
    });
    const res = await POST(
      new Request("http://x/api/webhooks/ses", {
        method: "POST",
        body: "{}",
      }),
    );
    expect(res.status).toBe(200);
  });
});
