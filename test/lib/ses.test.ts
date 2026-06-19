import { describe, it, expect, vi, beforeEach } from "vitest";

// Capture every command the client is asked to send so we can assert on the
// presence/absence of ConfigurationSetName across the original + retry attempts.
const sendMock = vi.fn();

vi.mock("@aws-sdk/client-sesv2", () => {
  class SendEmailCommand {
    input: Record<string, unknown>;
    constructor(input: Record<string, unknown>) {
      this.input = input;
    }
  }
  // Plain class (not a vi.fn) so the global afterEach restoreAllMocks() can't
  // strip its constructor; it just forwards to the resettable sendMock.
  class SESv2Client {
    send(cmd: unknown) {
      return sendMock(cmd);
    }
  }
  return {
    SESv2Client,
    SendEmailCommand,
    CreateEmailIdentityCommand: class {},
    GetEmailIdentityCommand: class {},
    GetAccountCommand: class {},
    CreateConfigurationSetCommand: class {},
    CreateConfigurationSetEventDestinationCommand: class {},
  };
});

import { sendEmail } from "@/lib/ses";

const baseOpts = {
  toEmail: "to@example.com",
  subject: "hi",
  bodyHtml: "<p>hi</p>",
  fromEmail: "from@example.com",
};

describe("sendEmail", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("sends with the configuration set on the happy path", async () => {
    sendMock.mockResolvedValueOnce({ MessageId: "mid-1" });

    const result = await sendEmail({ ...baseOpts, configurationSet: "envoy-x" });

    expect(result).toMatchObject({ success: true, messageId: "mid-1" });
    expect(result.trackingDisabled).toBeUndefined();
    expect(sendMock).toHaveBeenCalledTimes(1);
    expect(sendMock.mock.calls[0][0].input.ConfigurationSetName).toBe("envoy-x");
  });

  it("retries without the configuration set when it is missing, and flags tracking", async () => {
    sendMock
      .mockRejectedValueOnce(Object.assign(new Error("Configuration set <envoy-x> does not exist."), {
        name: "NotFoundException",
      }))
      .mockResolvedValueOnce({ MessageId: "mid-2" });

    const result = await sendEmail({ ...baseOpts, configurationSet: "envoy-x" });

    expect(result).toMatchObject({
      success: true,
      messageId: "mid-2",
      trackingDisabled: true,
      missingConfigurationSet: "envoy-x",
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
    // First attempt carried the config set; retry dropped it.
    expect(sendMock.mock.calls[0][0].input.ConfigurationSetName).toBe("envoy-x");
    expect(sendMock.mock.calls[1][0].input.ConfigurationSetName).toBeUndefined();
  });

  it("does not retry a NotFoundException when no configuration set was used", async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("nope"), { name: "NotFoundException" }),
    );

    const result = await sendEmail(baseOpts);

    expect(result).toMatchObject({ success: false, errorCode: "NotFoundException" });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("returns the error without retrying for non-NotFound failures", async () => {
    sendMock.mockRejectedValueOnce(
      Object.assign(new Error("throttled"), { name: "TooManyRequestsException" }),
    );

    const result = await sendEmail({ ...baseOpts, configurationSet: "envoy-x" });

    expect(result).toMatchObject({
      success: false,
      errorCode: "TooManyRequestsException",
    });
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it("surfaces a failure when the retry itself also fails", async () => {
    sendMock
      .mockRejectedValueOnce(Object.assign(new Error("missing"), { name: "NotFoundException" }))
      .mockRejectedValueOnce(Object.assign(new Error("blocked"), { name: "AccountSuspendedException" }));

    const result = await sendEmail({ ...baseOpts, configurationSet: "envoy-x" });

    expect(result).toMatchObject({
      success: false,
      errorCode: "AccountSuspendedException",
    });
    expect(sendMock).toHaveBeenCalledTimes(2);
  });
});
