import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => {
  const sql = vi.fn();
  const pool = {
    connect: vi.fn(async () => ({
      query: vi.fn(),
      release: vi.fn(),
    })),
    query: vi.fn(),
  };
  return {
    sql: Object.assign(sql, { query: vi.fn() }),
    getPool: () => pool,
  };
});

import { sql } from "@/lib/db";
const sqlMock = sql as unknown as ReturnType<typeof vi.fn>;
const sqlQuery = (sql as unknown as { query: ReturnType<typeof vi.fn> }).query;

import {
  getAll,
  getById,
  getByEmail,
  getByPhone,
  create,
  updateStatus,
  deleteTarget,
  count,
} from "@/lib/queries/targets";

describe("lib/queries/targets", () => {
  beforeEach(() => {
    sqlMock.mockReset();
    sqlQuery.mockReset();
  });

  describe("getAll — tenant isolation", () => {
    it("filters by organization_id always", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await getAll("org-1");
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("organization_id");
      expect(values).toContain("org-1");
    });

    it("clamps limit to MAX_PAGE_SIZE (500)", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await getAll("org-1", { limit: 100_000 });
      const [, ...values] = sqlMock.mock.calls[0];
      expect(values).toContain(500);
    });

    it("respects minimum limit of 1", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await getAll("org-1", { limit: -5 });
      const [, ...values] = sqlMock.mock.calls[0];
      expect(values).toContain(1);
    });

    it("forwards status/lifecycleStage filters", async () => {
      sqlMock.mockResolvedValueOnce([]);
      await getAll("org-1", { status: "active", lifecycleStage: 3 });
      const [, ...values] = sqlMock.mock.calls[0];
      expect(values).toContain("active");
      expect(values).toContain(3);
    });
  });

  describe("getById", () => {
    it("scopes by organization_id (tenant isolation)", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "t1", organization_id: "org-1" }]);
      const target = await getById("org-1", "t1");
      const [strings] = sqlMock.mock.calls[0];
      expect((strings as TemplateStringsArray).join("")).toContain("organization_id");
      expect(target?.id).toBe("t1");
    });

    it("returns null when target not found", async () => {
      sqlMock.mockResolvedValueOnce([]);
      expect(await getById("org-1", "missing")).toBeNull();
    });
  });

  describe("getByEmail / getByPhone", () => {
    it("getByEmail scopes by org + email", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "t1" }]);
      await getByEmail("org-1", "x@y.com");
      const [strings] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("organization_id");
      expect(text).toContain("email");
    });

    it("getByPhone scopes by org + phone_normalized", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "t1" }]);
      await getByPhone("org-1", "+14155551234");
      const [strings] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("organization_id");
      expect(text).toContain("phone_normalized");
    });
  });

  describe("create", () => {
    it("INSERTs with organization_id scoping", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "new-1", email: "a@b.com" }]);
      const result = await create("org-1", { email: "a@b.com", firstName: "X" });
      const [strings, ...values] = sqlMock.mock.calls[0];
      expect((strings as TemplateStringsArray).join("")).toContain("INSERT INTO targets");
      expect(values[0]).toBe("org-1");
      expect(result.email).toBe("a@b.com");
    });
  });

  describe("updateStatus", () => {
    it("UPDATEs status by email globally (cross-tenant intentional for bounce/complaint flow)", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "t1" }]);
      const n = await updateStatus("x@y.com", "bounced");
      const [strings, ...values] = sqlMock.mock.calls[0];
      const text = (strings as TemplateStringsArray).join("");
      expect(text).toContain("UPDATE targets");
      expect(text).toContain("email =");
      expect(values).toContain("bounced");
      expect(values).toContain("x@y.com");
      expect(n).toBe(1);
    });
  });

  describe("deleteTarget", () => {
    it("DELETEs scoped by organization_id", async () => {
      sqlMock.mockResolvedValueOnce([{ id: "t1" }]);
      await deleteTarget("org-1", "t1");
      const [strings] = sqlMock.mock.calls[0];
      expect((strings as TemplateStringsArray).join("")).toContain("organization_id");
    });
  });

  describe("count", () => {
    it("returns count number scoped by org", async () => {
      sqlMock.mockResolvedValueOnce([{ count: 42 }]);
      const n = await count("org-1");
      expect(n).toBe(42);
    });

    it("forwards status filter as positional arg", async () => {
      sqlMock.mockResolvedValueOnce([{ count: 7 }]);
      await count("org-1", "active");
      const [, ...values] = sqlMock.mock.calls[0];
      expect(values).toContain("active");
      expect(values).toContain("org-1");
    });
  });
});
