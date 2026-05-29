import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  return { sql: Object.assign(sql, { query: vi.fn() }) };
});

import { sql } from "@/lib/db";
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;

import {
  create,
  getById,
  count,
  approve,
  reject,
  markSent,
  markFailed,
} from "@/lib/queries/outbox";

describe("lib/queries/outbox", () => {
  beforeEach(() => {
    sqlMock.mockReset();
  });

  describe("create", () => {
    it("INSERTs with org + target ids and returns the row", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "o1", status: "pending" }]);
      const row = await create("org-1", "t1", "email", "body");
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("INSERT INTO outbox");
      expect(values).toContain("org-1");
      expect(values).toContain("t1");
      expect(row.id).toBe("o1");
    });

    it("defaults priority=5 and status=pending", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "o1" }]);
      await create("org-1", "t1", "email", "body");
      const [, ...values] = sqlMock.mock.calls[0];
      expect(values).toContain(5);
      expect(values).toContain("pending");
    });

    it("respects status=approved override (sets reviewed_at NOW)", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "o1", status: "approved" }]);
      await create("org-1", "t1", "email", "b", { status: "approved" });
      const [, ...values] = sqlMock.mock.calls[0];
      expect(values).toContain("approved");
    });
  });

  describe("getById", () => {
    it("scopes by organization_id (tenant isolation)", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "o1", organization_id: "org-1" }]);
      const row = await getById("org-1", "o1");
      const [strings] = sqlMock.mock.calls[0];
      expect((strings as TemplateStringsArray).join("")).toContain("organization_id");
      expect(row?.id).toBe("o1");
    });

    it("returns null when not found", async () => {
      sqlMock.mockResolvedValueOnce([]);
      expect(await getById("org-1", "missing")).toBeNull();
    });
  });

  describe("count", () => {
    it("returns aggregate count", async () => {
      sqlMock.mockResolvedValueOnce([{ count: 10 }]);
      expect(await count("org-1")).toBe(10);
    });

    it("forwards optional status filter", async () => {
      sqlMock.mockResolvedValueOnce([{ count: 3 }]);
      await count("org-1", "pending");
      const [, ...values] = sqlMock.mock.calls[0];
      expect(values).toContain("pending");
    });
  });

  describe("approve / reject / markSent / markFailed", () => {
    it("approve scopes by org and sets approved status", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "o1", status: "approved" }]);
      const result = await approve("org-1", "o1", "reviewer-1");
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("UPDATE outbox");
      expect(text).toContain("organization_id");
      expect(text).toContain("'approved'");
      expect(values).toContain("o1");
      expect(values).toContain("org-1");
      expect(result?.id).toBe("o1");
    });

    it("reject scopes by org and records reason + reviewer", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "o1", status: "rejected" }]);
      await reject("org-1", "o1", "low quality", "reviewer-1");
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("'rejected'");
      expect(values).toContain("low quality");
    });

    it("markSent persists send_result JSON", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "o1" }]);
      await markSent("org-1", "o1", { messageId: "ses-x" });
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("UPDATE outbox");
      expect(text).toContain("organization_id");
      expect(text).toContain("'sent'");
      // send_result is JSON-stringified as a value
      const hasResult = values.some(
        (v) => typeof v === "string" && v.includes("messageId"),
      );
      expect(hasResult).toBe(true);
    });

    it("markFailed records error reason", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "o1" }]);
      await markFailed("org-1", "o1", "SES bounced");
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("'failed'");
      const hasErr = values.some(
        (v) => typeof v === "string" && v.includes("SES bounced"),
      );
      expect(hasErr).toBe(true);
    });
  });
});
