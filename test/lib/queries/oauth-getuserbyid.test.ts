import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/db", () => ({
  sql: Object.assign(vi.fn(), { query: vi.fn() }),
}));

import { sql } from "@/lib/db";
const sqlTemplate = sql as unknown as ReturnType<typeof vi.fn>;

import { getUserById } from "@/lib/queries/oauth";

describe("lib/queries/oauth getUserById", () => {
  beforeEach(() => {
    sqlTemplate.mockReset();
  });

  it("filters to active users only — query includes u.status = 'active'", async () => {
    sqlTemplate.mockResolvedValueOnce([
      { id: "u-1", organization_id: "org-1", status: "active" },
    ]);

    await getUserById("u-1");

    const [strings] = sqlTemplate.mock.calls[0];
    const text = (strings as TemplateStringsArray).join("");
    expect(text).toContain("u.status = 'active'");
  });

  it("returns null when sql returns [] (deactivated user filtered out)", async () => {
    sqlTemplate.mockResolvedValueOnce([]);

    expect(await getUserById("deactivated-user")).toBeNull();
  });

  it("returns the mapped user row when an active user is found", async () => {
    sqlTemplate.mockResolvedValueOnce([
      {
        id: 42,
        organization_id: 7,
        email: "a@b.com",
        first_name: "Ada",
        last_name: "Lovelace",
        role: "admin",
        scopes: ["read", "write", "admin"],
        status: "active",
        created_at: "2026-01-01",
        org_name: "Acme",
      },
    ]);

    const row = await getUserById("u-1");
    expect(row).not.toBeNull();
    expect(row?.id).toBe("42");
    expect(row?.organization_id).toBe("7");
    expect(row?.status).toBe("active");
    expect(row?.org_name).toBe("Acme");
  });

  it("scopes the lookup by the requested user id", async () => {
    sqlTemplate.mockResolvedValueOnce([{ id: "u-9", status: "active" }]);

    await getUserById("u-9");

    const [, ...values] = sqlTemplate.mock.calls[0];
    expect(values).toContain("u-9");
  });
});
