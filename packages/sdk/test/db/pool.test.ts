import { describe, expect, it, vi } from "vitest";

import {
  createDb,
  NamespacedDb,
  type SdkPool,
  type SdkQueryResult,
} from "@sdk/db/pool.js";

/**
 * A fake `pg`-compatible pool. Each call returns the next queued result and records the
 * (text, params) so tests can assert what hit the DB. No real network/DB (KTD: mocked).
 */
function fakePool(results: Array<SdkQueryResult<Record<string, unknown>>>): {
  pool: SdkPool;
  calls: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
} {
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];
  let i = 0;
  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const result = results[i] ?? { rows: [] };
      i += 1;
      return result as never;
    }),
  };
  return { pool, calls };
}

describe("createDb / NamespacedDb construction", () => {
  it("returns a NamespacedDb bound to the namespace", () => {
    const { pool } = fakePool([]);
    const db = createDb(pool, "prod");
    expect(db).toBeInstanceOf(NamespacedDb);
    expect(db.namespace).toBe("prod");
  });

  it("rejects an empty namespace (fail loud, R38)", () => {
    const { pool } = fakePool([]);
    expect(() => createDb(pool, "")).toThrow(/non-empty string/);
  });

  it("rejects a namespace containing the separator (R38)", () => {
    const { pool } = fakePool([]);
    expect(() => createDb(pool, "prod:eu")).toThrow(/separator/);
  });
});

describe("namespaceKey / stripNamespace", () => {
  it("prefixes a bare key with the install namespace (KTD7)", () => {
    const { pool } = fakePool([]);
    const db = createDb(pool, "prod");
    expect(db.namespaceKey("user@example.com")).toBe("prod:user@example.com");
  });

  it("two namespaces do NOT collide on the same logical key (R38/KTD7)", () => {
    const { pool } = fakePool([]);
    const prod = createDb(pool, "prod");
    const staging = createDb(pool, "staging");
    const key = "weekly-digest";
    expect(prod.namespaceKey(key)).not.toBe(staging.namespaceKey(key));
    expect(prod.namespaceKey(key)).toBe("prod:weekly-digest");
    expect(staging.namespaceKey(key)).toBe("staging:weekly-digest");
  });

  it("round-trips namespaceKey -> stripNamespace", () => {
    const { pool } = fakePool([]);
    const db = createDb(pool, "prod");
    const stored = db.namespaceKey("abc");
    expect(db.stripNamespace(stored)).toBe("abc");
  });

  it("stripNamespace fails loud on a foreign-namespace key (R38)", () => {
    const { pool } = fakePool([]);
    const db = createDb(pool, "prod");
    expect(() => db.stripNamespace("staging:abc")).toThrow(/cross-namespace/);
  });

  it("rejects an empty key", () => {
    const { pool } = fakePool([]);
    const db = createDb(pool, "prod");
    expect(() => db.namespaceKey("")).toThrow(/non-empty string/);
  });
});

describe("execWrite success derived from rows.length, not rowCount", () => {
  it("reports count from rows.length on a won write", async () => {
    // Note: result intentionally carries NO rowCount field — the wrapper must not read it.
    const { pool } = fakePool([{ rows: [{ id: 1 }] }]);
    const db = createDb(pool, "prod");
    const { count, rows } = await db.execWrite(
      "INSERT INTO t (k) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id",
      ["prod:abc"]
    );
    expect(count).toBe(1);
    expect(rows).toEqual([{ id: 1 }]);
  });

  it("reports count 0 when a claim loses the race (zero returned rows)", async () => {
    const { pool } = fakePool([{ rows: [] }]);
    const db = createDb(pool, "prod");
    const { count } = await db.execWrite(
      "INSERT INTO t (k) VALUES ($1) ON CONFLICT DO NOTHING RETURNING id",
      ["prod:abc"]
    );
    expect(count).toBe(0);
  });

  it("ignores a driver-supplied rowCount entirely (Neon returns none)", async () => {
    // Simulate a driver that reports a bogus rowCount but the real rows are empty.
    const result = { rows: [], rowCount: 5 } as unknown as SdkQueryResult;
    const { pool } = fakePool([result]);
    const db = createDb(pool, "prod");
    const { count } = await db.execWrite("UPDATE t SET x = 1 RETURNING id");
    expect(count).toBe(0);
  });

  it("tolerates a missing rows array (defensive)", async () => {
    const { pool } = fakePool([{} as SdkQueryResult]);
    const db = createDb(pool, "prod");
    const { count, rows } = await db.execWrite("UPDATE t SET x = 1 RETURNING id");
    expect(count).toBe(0);
    expect(rows).toEqual([]);
  });
});

describe("query passthrough", () => {
  it("forwards text + params to the host pool and returns rows", async () => {
    const { pool, calls } = fakePool([{ rows: [{ email: "a@b.com" }] }]);
    const db = createDb(pool, "prod");
    const res = await db.query<{ email: string }>(
      "SELECT email FROM sdk_contacts WHERE namespace = $1",
      ["prod"]
    );
    expect(res.rows).toEqual([{ email: "a@b.com" }]);
    expect(calls[0]).toEqual({
      text: "SELECT email FROM sdk_contacts WHERE namespace = $1",
      params: ["prod"],
    });
  });
});
