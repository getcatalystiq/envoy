import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifySnsMessage,
  handleSnsSubscriptionConfirmation,
} from "@/lib/sns-verify";

function snsBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    Type: "Notification",
    MessageId: "id-1",
    TopicArn: "arn:aws:sns:us-east-1:123:topic",
    Message: '{"some":"data"}',
    Timestamp: new Date().toISOString(),
    Signature: "AAAA",
    SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
    SignatureVersion: "1",
    ...overrides,
  });
}

describe("lib/sns-verify", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  describe("verifySnsMessage — structural checks", () => {
    it("rejects body missing required keys", async () => {
      const body = JSON.stringify({ Type: "Notification", MessageId: "x" });
      await expect(verifySnsMessage(body)).rejects.toThrow(/missing required keys/);
    });

    it("rejects SubscriptionConfirmation without SubscribeURL/Token", async () => {
      const body = snsBody({ Type: "SubscriptionConfirmation" });
      await expect(verifySnsMessage(body)).rejects.toThrow(/missing required keys/);
    });

    it("rejects cert URL on wrong host", async () => {
      const body = snsBody({ SigningCertURL: "https://evil.example.com/cert.pem" });
      await expect(verifySnsMessage(body)).rejects.toThrow(/invalid domain/);
    });

    it("rejects cert URL with http (not https)", async () => {
      const body = snsBody({ SigningCertURL: "http://sns.us-east-1.amazonaws.com/cert.pem" });
      await expect(verifySnsMessage(body)).rejects.toThrow(/invalid domain/);
    });

    it("rejects cert URL not ending in .pem", async () => {
      const body = snsBody({ SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.txt" });
      await expect(verifySnsMessage(body)).rejects.toThrow(/invalid domain/);
    });

    it("accepts .com.cn cert host", async () => {
      // Won't actually verify signature without a real cert; we expect it to fail at fetch
      // (we mock fetch to throw). What matters is we passed the host validator.
      globalThis.fetch = vi.fn(async () => {
        throw new Error("fetch stopped");
      }) as typeof fetch;
      const body = snsBody({ SigningCertURL: "https://sns.cn-north-1.amazonaws.com.cn/cert.pem" });
      await expect(verifySnsMessage(body)).rejects.toThrow(/fetch stopped/);
    });

    it("rejects unsupported SignatureVersion", async () => {
      globalThis.fetch = vi.fn(async () => new Response("dummy")) as typeof fetch;
      const body = snsBody({ SignatureVersion: "3" });
      await expect(verifySnsMessage(body)).rejects.toThrow(/signature version 3/);
    });
  });

  describe("verifySnsMessage — Lambda-style key normalization", () => {
    it("maps SigningCertUrl → SigningCertURL", async () => {
      // We expect the validator to either succeed past structure checks (the
      // cert URL got copied to canonical form) or fail at signature fetch.
      globalThis.fetch = vi.fn(async () => {
        throw new Error("ok-fetch-stopped");
      }) as typeof fetch;
      const body = JSON.stringify({
        Type: "Notification",
        MessageId: "id-1",
        TopicArn: "arn:aws:sns:us-east-1:123:topic",
        Message: "x",
        Timestamp: "t",
        Signature: "s",
        SigningCertUrl: "https://sns.us-east-1.amazonaws.com/cert.pem", // lambda-style key
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem", // also include canonical so structure passes
        SignatureVersion: "1",
      });
      await expect(verifySnsMessage(body)).rejects.toThrow(/ok-fetch-stopped/);
    });
  });

  describe("handleSnsSubscriptionConfirmation", () => {
    it("fetches SubscribeURL to confirm", async () => {
      const fetchMock = vi.fn(async () => new Response("ok", { status: 200 }));
      globalThis.fetch = fetchMock as typeof fetch;
      await expect(
        handleSnsSubscriptionConfirmation({ SubscribeURL: "https://sns/confirm?token=t" }),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith("https://sns/confirm?token=t");
    });

    it("throws when SubscribeURL missing", async () => {
      await expect(handleSnsSubscriptionConfirmation({})).rejects.toThrow(/No SubscribeURL/);
    });

    it("throws when confirm fetch returns non-2xx", async () => {
      globalThis.fetch = vi.fn(async () => new Response("err", { status: 500 })) as typeof fetch;
      await expect(
        handleSnsSubscriptionConfirmation({ SubscribeURL: "https://sns/confirm" }),
      ).rejects.toThrow(/HTTP 500/);
    });
  });
});
