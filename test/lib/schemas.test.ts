import { describe, it, expect } from "vitest";
import {
  targetCreateSchema,
  targetUpdateSchema,
  contentCreateSchema,
  contentGenerateSchema,
  campaignCreateSchema,
  sendRequestSchema,
  analyticsQuerySchema,
  twinUpdateInstructionsRequestSchema,
  twinListRunsQuerySchema,
} from "@/lib/schemas";

describe("lib/schemas", () => {
  describe("targetCreateSchema", () => {
    it("accepts minimal valid input", () => {
      const r = targetCreateSchema.safeParse({ email: "a@b.com" });
      expect(r.success).toBe(true);
      if (r.success) {
        expect(r.data.lifecycle_stage).toBe(0); // default
        expect(r.data.custom_fields).toEqual({}); // default
      }
    });

    it("rejects invalid email", () => {
      expect(targetCreateSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    });

    it("rejects out-of-range lifecycle_stage", () => {
      expect(targetCreateSchema.safeParse({ email: "a@b.com", lifecycle_stage: -1 }).success).toBe(false);
      expect(targetCreateSchema.safeParse({ email: "a@b.com", lifecycle_stage: 7 }).success).toBe(false);
    });

    it("rejects first_name longer than 100 chars", () => {
      expect(
        targetCreateSchema.safeParse({ email: "a@b.com", first_name: "x".repeat(101) }).success,
      ).toBe(false);
    });

    it("accepts nullable first_name/last_name/company", () => {
      const r = targetCreateSchema.safeParse({
        email: "a@b.com",
        first_name: null,
        last_name: null,
        company: null,
      });
      expect(r.success).toBe(true);
    });
  });

  describe("targetUpdateSchema", () => {
    it("accepts partial updates", () => {
      expect(targetUpdateSchema.safeParse({ first_name: "X" }).success).toBe(true);
      expect(targetUpdateSchema.safeParse({ status: "unsubscribed" }).success).toBe(true);
    });

    it("rejects invalid status enum", () => {
      expect(targetUpdateSchema.safeParse({ status: "garbage" }).success).toBe(false);
    });
  });

  describe("contentCreateSchema", () => {
    it("validates required content_type enum", () => {
      const ok = contentCreateSchema.safeParse({
        name: "Test",
        content_type: "educational",
        body: "Hi",
      });
      expect(ok.success).toBe(true);

      const bad = contentCreateSchema.safeParse({
        name: "Test",
        content_type: "garbage",
        body: "Hi",
      });
      expect(bad.success).toBe(false);
    });

    it("requires non-empty body", () => {
      expect(
        contentCreateSchema.safeParse({
          name: "T",
          content_type: "educational",
          body: "",
        }).success,
      ).toBe(false);
    });

    it("defaults channel to 'email'", () => {
      const r = contentCreateSchema.safeParse({
        name: "T",
        content_type: "educational",
        body: "x",
      });
      expect(r.success && r.data.channel).toBe("email");
    });
  });

  describe("contentGenerateSchema", () => {
    it("requires target_id uuid", () => {
      expect(
        contentGenerateSchema.safeParse({
          target_id: "not-a-uuid",
          content_type: "educational",
        }).success,
      ).toBe(false);
    });
  });

  describe("campaignCreateSchema", () => {
    it("accepts minimal valid", () => {
      expect(campaignCreateSchema.safeParse({ name: "C1" }).success).toBe(true);
    });

    it("rejects empty name", () => {
      expect(campaignCreateSchema.safeParse({ name: "" }).success).toBe(false);
    });
  });

  describe("sendRequestSchema", () => {
    it("validates target_id is a uuid", () => {
      const ok = sendRequestSchema.safeParse({
        target_id: "11111111-1111-4111-8111-111111111111",
      });
      expect(ok.success).toBe(true);
    });

    it("rejects malformed uuid", () => {
      expect(
        sendRequestSchema.safeParse({ target_id: "not-a-uuid" }).success,
      ).toBe(false);
    });
  });

  describe("analyticsQuerySchema", () => {
    it("accepts empty + defaults", () => {
      const r = analyticsQuerySchema.safeParse({});
      expect(r.success).toBe(true);
    });
  });

  describe("twin* schemas", () => {
    it("twinUpdateInstructions requires non-empty content", () => {
      expect(
        twinUpdateInstructionsRequestSchema.safeParse({ content: "" }).success,
      ).toBe(false);
      expect(
        twinUpdateInstructionsRequestSchema.safeParse({ content: "do the thing" }).success,
      ).toBe(true);
    });

    it("twinUpdateInstructions enforces max length", () => {
      const tooLong = "x".repeat(100_001);
      expect(
        twinUpdateInstructionsRequestSchema.safeParse({ content: tooLong }).success,
      ).toBe(false);
    });

    it("twinListRunsQuery validates page/page_size positive ints", () => {
      expect(
        twinListRunsQuerySchema.safeParse({ page: 0 }).success,
      ).toBe(false);
      expect(
        twinListRunsQuerySchema.safeParse({ page: 1, page_size: 50 }).success,
      ).toBe(true);
      expect(
        twinListRunsQuerySchema.safeParse({ page_size: 9999 }).success,
      ).toBe(false);
    });
  });
});
