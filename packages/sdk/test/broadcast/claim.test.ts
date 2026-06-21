import { describe, expect, it, vi } from "vitest";

import {
  claim,
  persistBroadcastId,
  markSent,
  resolveResumeBroadcastId,
  DEFAULT_PRECHECK_MAX_PAGES,
} from "@sdk/broadcast/claim.js";
import { createDb, NamespacedDb, type SdkPool } from "@sdk/db/pool.js";
import type { ResendClientHandle } from "@sdk/resend/client.js";

// =============================================================================================
// In-memory fake of the `sdk_broadcast_claims` slice claim.ts touches. It models EXACTLY the four
// statements the module issues, keyed by (namespace, broadcast_key):
//   - INSERT … ON CONFLICT (namespace, broadcast_key) DO NOTHING RETURNING …   (claim)
//   - SELECT … WHERE namespace=$1 AND broadcast_key=$2                          (claim read-back)
//   - UPDATE … SET resend_broadcast_id=$3 … RETURNING …                         (persistBroadcastId)
//   - UPDATE … SET sent_at=NOW(), item_ids=COALESCE($3,item_ids) … RETURNING …  (markSent)
// Returning `rows` with NO `rowCount` field, exactly like Neon's HTTP driver — so a test fails if
// the module ever reads `rowCount`.
// =============================================================================================

interface StoredClaim {
  broadcast_key: string;
  resend_broadcast_id: string | null;
  item_ids: string[];
  sent_at: string | null;
  created_at: string;
}

function claimsPool(seed?: { createdAt?: string }): {
  pool: SdkPool;
  store: Map<string, StoredClaim>;
  calls: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
} {
  const store = new Map<string, StoredClaim>(); // `${namespace}|${broadcast_key}` -> row
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];
  const k = (ns: unknown, key: unknown) => `${ns}|${key}`;
  const now = () => new Date().toISOString();

  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();
      const p = params ?? [];

      if (t.startsWith("INSERT INTO sdk_broadcast_claims")) {
        const key = k(p[0], p[1]);
        if (store.has(key)) {
          // ON CONFLICT DO NOTHING — no returned row (the loss signal).
          return { rows: [] } as never;
        }
        const row: StoredClaim = {
          broadcast_key: p[1] as string,
          resend_broadcast_id: null,
          item_ids: (p[2] as string[]) ?? [],
          sent_at: null,
          created_at: seed?.createdAt ?? now(),
        };
        store.set(key, row);
        return { rows: [{ ...row }] } as never;
      }

      if (t.startsWith("SELECT") && t.includes("FROM sdk_broadcast_claims")) {
        const found = store.get(k(p[0], p[1]));
        return { rows: found ? [{ ...found }] : [] } as never;
      }

      if (t.startsWith("UPDATE sdk_broadcast_claims") && t.includes("resend_broadcast_id = $3")) {
        const found = store.get(k(p[0], p[1]));
        if (!found) return { rows: [] } as never;
        found.resend_broadcast_id = p[2] as string;
        return { rows: [{ ...found }] } as never;
      }

      if (t.startsWith("UPDATE sdk_broadcast_claims") && t.includes("sent_at = NOW()")) {
        const found = store.get(k(p[0], p[1]));
        if (!found) return { rows: [] } as never;
        found.sent_at = now();
        const incoming = p[2] as string[] | null;
        if (incoming !== null) found.item_ids = incoming; // COALESCE($3, item_ids)
        return { rows: [{ ...found }] } as never;
      }

      return { rows: [] } as never;
    }),
  };

  return { pool, store, calls };
}

// ---------------------------------------------------------------------------------------------
// Fake Resend handle exposing a controllable `broadcasts.list`. `pages` is a list of returned
// pages (newest-first per Resend); the fake serves them in order regardless of the `after` cursor
// (sufficient to exercise paging/budget logic). `error` forces a list failure.
// ---------------------------------------------------------------------------------------------

interface ListEntry {
  id: string;
  name: string;
  created_at: string;
}

function fakeResend(opts?: {
  enabled?: boolean;
  pages?: ListEntry[][];
  error?: { message: string };
}): { handle: ResendClientHandle; list: ReturnType<typeof vi.fn> } {
  const enabled = opts?.enabled ?? true;
  const pages = opts?.pages ?? [];
  let pageIdx = 0;

  const list = vi.fn(async (_options?: { limit?: number; after?: string }) => {
    if (opts?.error) {
      return { data: null, error: opts.error };
    }
    const data = pages[pageIdx] ?? [];
    const has_more = pageIdx < pages.length - 1;
    pageIdx += 1;
    return { data: { data, has_more }, error: null };
  });

  const fakeClient = { broadcasts: { list } };
  const handle: ResendClientHandle = {
    enabled,
    client: () => (enabled ? (fakeClient as never) : null),
  };
  return { handle, list };
}

// =============================================================================================
// claim()
// =============================================================================================

describe("claim — atomic send-once guard (R30)", () => {
  it("first claim wins and returns a fresh row; a concurrent second loses (does not send)", async () => {
    const { pool } = claimsPool();
    const db = createDb(pool, "prod");

    const first = await claim(db, "weekly:2026-06-21", { itemIds: ["a", "b"] });
    expect(first.won).toBe(true);
    expect(first.resumable).toBe(false);
    expect(first.row.broadcastKey).toBe("weekly:2026-06-21"); // bare key, not namespaced
    expect(first.row.sentAt).toBeNull();
    expect(first.row.resendBroadcastId).toBeNull();
    expect(first.row.itemIds).toEqual(["a", "b"]);

    const second = await claim(db, "weekly:2026-06-21");
    expect(second.won).toBe(false);
    // Unsent prior attempt is resumable, not a duplicate.
    expect(second.resumable).toBe(true);
    expect(second.row.broadcastKey).toBe("weekly:2026-06-21");
  });

  it("namespaces the stored key so two installs never collide on the same broadcastKey", async () => {
    const { pool, calls } = claimsPool();
    const prod = createDb(pool, "prod");
    const staging = createDb(pool, "staging");

    const a = await claim(prod, "issue-1");
    const b = await claim(staging, "issue-1");

    // Both win — distinct stored keys despite the same bare broadcastKey.
    expect(a.won).toBe(true);
    expect(b.won).toBe(true);

    const inserts = calls.filter((c) => c.text.trim().startsWith("INSERT INTO sdk_broadcast_claims"));
    expect(inserts[0]!.params).toEqual(["prod", "prod:issue-1", []]);
    expect(inserts[1]!.params).toEqual(["staging", "staging:issue-1", []]);
  });

  it("won/lost is derived from rows.length, never a driver rowCount", async () => {
    // The pool returns NO rowCount field at all; a win is read from the single returned row.
    const { pool } = claimsPool();
    const db = createDb(pool, "prod");
    const res = await claim(db, "k");
    expect(res.won).toBe(true);
  });

  it("a lost claim whose existing row is already sent is NOT resumable (do nothing)", async () => {
    const { pool, store } = claimsPool();
    const db = createDb(pool, "prod");
    await claim(db, "k");
    // Simulate the prior attempt having completed.
    store.get("prod|prod:k")!.sent_at = new Date().toISOString();

    const second = await claim(db, "k");
    expect(second.won).toBe(false);
    expect(second.resumable).toBe(false);
    expect(second.row.sentAt).not.toBeNull();
  });

  it("fails loud if a conflicted claim cannot be read back (torn write / namespace drift)", async () => {
    // A pool where the INSERT always conflicts (0 rows) AND the SELECT read-back returns nothing.
    const pool: SdkPool = {
      query: vi.fn(async (text: string) => {
        if (text.trim().startsWith("INSERT")) return { rows: [] } as never;
        return { rows: [] } as never; // SELECT read-back also empty
      }),
    };
    const db = createDb(pool, "prod");
    await expect(claim(db, "k")).rejects.toThrow(/could not be\s+read back|fail loud/i);
  });

  it("rejects an empty broadcastKey", async () => {
    const { pool } = claimsPool();
    const db = createDb(pool, "prod");
    await expect(claim(db, "")).rejects.toThrow(/non-empty string/);
  });
});

// =============================================================================================
// persistBroadcastId() — the common-path id persist
// =============================================================================================

describe("persistBroadcastId — persist the Resend id after broadcasts.create", () => {
  it("persists the id into the claim row so resume reads it directly", async () => {
    const { pool, store } = claimsPool();
    const db = createDb(pool, "prod");
    await claim(db, "k");

    const row = await persistBroadcastId(db, "k", "bc_123");
    expect(row.resendBroadcastId).toBe("bc_123");
    expect(store.get("prod|prod:k")!.resend_broadcast_id).toBe("bc_123");
    expect(row.broadcastKey).toBe("k"); // bare key returned
  });

  it("throws when there is no claim row (must claim first)", async () => {
    const { pool } = claimsPool();
    const db = createDb(pool, "prod");
    await expect(persistBroadcastId(db, "missing", "bc_1")).rejects.toThrow(/no claim row/);
  });

  it("rejects an empty id", async () => {
    const { pool } = claimsPool();
    const db = createDb(pool, "prod");
    await claim(db, "k");
    await expect(persistBroadcastId(db, "k", "")).rejects.toThrow(/non-empty string/);
  });
});

// =============================================================================================
// markSent()
// =============================================================================================

describe("markSent — terminal send marker", () => {
  it("sets sent_at and records item ids; a subsequent claim is a non-resumable loss", async () => {
    const { pool } = claimsPool();
    const db = createDb(pool, "prod");
    await claim(db, "k");

    const row = await markSent(db, "k", { itemIds: ["x", "y"] });
    expect(row.sentAt).not.toBeNull();
    expect(row.itemIds).toEqual(["x", "y"]);

    const after = await claim(db, "k");
    expect(after.won).toBe(false);
    expect(after.resumable).toBe(false);
  });

  it("throws when there is no claim row", async () => {
    const { pool } = claimsPool();
    const db = createDb(pool, "prod");
    await expect(markSent(db, "missing")).rejects.toThrow(/no claim row/);
  });
});

// =============================================================================================
// resolveResumeBroadcastId() — crash-safe resume
// =============================================================================================

describe("resolveResumeBroadcastId — common path (id persisted)", () => {
  it("reads the persisted id directly without listing Resend", async () => {
    const { handle, list } = fakeResend({ pages: [] });
    const res = await resolveResumeBroadcastId(handle, {
      broadcastKey: "k",
      resendBroadcastId: "bc_persisted",
      createdAt: new Date().toISOString(),
    });
    expect(res).toEqual({ status: "exists", broadcastId: "bc_persisted", source: "persisted" });
    expect(list).not.toHaveBeenCalled();
  });
});

describe("resolveResumeBroadcastId — crash gap (id absent) precheck", () => {
  it("pages broadcasts.list bounded by created_at and resumes on a name match (no re-create)", async () => {
    const claimCreatedAt = "2026-06-21T10:00:00.000Z";
    // Page 1 newest-first: a newer unrelated broadcast, then OUR deterministic-name match.
    const pages: ListEntry[][] = [
      [
        { id: "bc_newer", name: "other:key", created_at: "2026-06-21T10:05:00.000Z" },
        { id: "bc_ours", name: "weekly:2026-06-21", created_at: "2026-06-21T10:00:30.000Z" },
      ],
    ];
    const { handle, list } = fakeResend({ pages });

    const res = await resolveResumeBroadcastId(
      handle,
      { broadcastKey: "weekly:2026-06-21", resendBroadcastId: null, createdAt: claimCreatedAt },
      { sleep: async () => {} }
    );
    expect(res).toEqual({ status: "exists", broadcastId: "bc_ours", source: "precheck" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("stops the walk once entries fall below the claim's created_at (true negative, not exhaustion)", async () => {
    const claimCreatedAt = "2026-06-21T10:00:00.000Z";
    // Page 1: all OLDER than the claim → our broadcast cannot be here or later. Safe to create.
    const pages: ListEntry[][] = [
      [
        { id: "bc_old1", name: "old:a", created_at: "2026-06-20T09:00:00.000Z" },
        { id: "bc_old2", name: "old:b", created_at: "2026-06-19T09:00:00.000Z" },
      ],
    ];
    const { handle } = fakeResend({ pages });
    const res = await resolveResumeBroadcastId(
      handle,
      { broadcastKey: "weekly:2026-06-21", resendBroadcastId: null, createdAt: claimCreatedAt },
      { sleep: async () => {}, retries: 0 }
    );
    expect(res).toEqual({ status: "absent" });
  });

  it("returns absent when no broadcast matches within the in-window range (safe to create)", async () => {
    const claimCreatedAt = "2026-06-21T10:00:00.000Z";
    const pages: ListEntry[][] = [
      [{ id: "bc_unrelated", name: "different:key", created_at: "2026-06-21T10:02:00.000Z" }],
    ];
    const { handle, list } = fakeResend({ pages });
    const res = await resolveResumeBroadcastId(
      handle,
      { broadcastKey: "weekly:2026-06-21", resendBroadcastId: null, createdAt: claimCreatedAt },
      { sleep: async () => {}, retries: 0 }
    );
    expect(res).toEqual({ status: "absent" });
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("retries the walk to absorb replication lag, then finds the match on a later attempt", async () => {
    const claimCreatedAt = "2026-06-21T10:00:00.000Z";
    // First attempt: empty list (broadcast not yet listable). Second attempt: the match appears.
    // The fake serves pages sequentially across BOTH attempts, so attempt 1 sees page[0] (empty,
    // has_more false), attempt 2 sees page[1] (the match).
    const pages: ListEntry[][] = [
      [],
      [{ id: "bc_lagged", name: "weekly:2026-06-21", created_at: "2026-06-21T10:00:10.000Z" }],
    ];
    const { handle, list } = fakeResend({ pages });
    const sleep = vi.fn(async () => {});
    const res = await resolveResumeBroadcastId(
      handle,
      { broadcastKey: "weekly:2026-06-21", resendBroadcastId: null, createdAt: claimCreatedAt },
      { sleep, retries: 2 }
    );
    expect(res).toEqual({ status: "exists", broadcastId: "bc_lagged", source: "precheck" });
    expect(sleep).toHaveBeenCalledTimes(1); // one retry delay before the second attempt
    expect(list).toHaveBeenCalledTimes(2);
  });

  it("FAILS LOUD when the page budget is exhausted (high-volume host) — never blind re-creates", async () => {
    const claimCreatedAt = "2026-06-21T10:00:00.000Z";
    // Build maxPages+1 pages, each in-window (newer than the claim), each has_more=true, none
    // matching — so the walk hits its budget before resolving.
    const maxPages = 3;
    const pages: ListEntry[][] = [];
    for (let i = 0; i < maxPages + 1; i += 1) {
      pages.push([
        { id: `bc_${i}`, name: `no-match:${i}`, created_at: "2026-06-21T10:30:00.000Z" },
      ]);
    }
    const { handle } = fakeResend({ pages });

    await expect(
      resolveResumeBroadcastId(
        handle,
        { broadcastKey: "weekly:2026-06-21", resendBroadcastId: null, createdAt: claimCreatedAt },
        { sleep: async () => {}, retries: 0, maxPages }
      )
    ).rejects.toThrow(/exhausted|fail loud/i);
  });

  it("throws when Resend is unset and the id is absent (cannot resolve — refuse blind re-create)", async () => {
    const { handle } = fakeResend({ enabled: false });
    await expect(
      resolveResumeBroadcastId(handle, {
        broadcastKey: "k",
        resendBroadcastId: null,
        createdAt: new Date().toISOString(),
      })
    ).rejects.toThrow(/not configured|fail loud/i);
  });

  it("throws (fail loud) on a Resend broadcasts.list error", async () => {
    const { handle } = fakeResend({ error: { message: "boom" } });
    await expect(
      resolveResumeBroadcastId(
        handle,
        { broadcastKey: "k", resendBroadcastId: null, createdAt: new Date().toISOString() },
        { sleep: async () => {}, retries: 0 }
      )
    ).rejects.toThrow(/broadcasts\.list precheck failed|boom/i);
  });

  it("defaults the page budget to DEFAULT_PRECHECK_MAX_PAGES", () => {
    expect(DEFAULT_PRECHECK_MAX_PAGES).toBeGreaterThan(0);
  });
});

// =============================================================================================
// End-to-end: claim → persist → resume reads the id directly (the common, no-list path)
// =============================================================================================

describe("end-to-end common path: claim → persist → resume without listing", () => {
  it("resume reads the persisted id and never calls broadcasts.list", async () => {
    const { pool } = claimsPool();
    const db = createDb(pool, "prod");
    const { handle, list } = fakeResend({ pages: [] });

    const won = await claim(db, "k", { itemIds: ["i1"] });
    expect(won.won).toBe(true);
    await persistBroadcastId(db, "k", "bc_42");

    // A concurrent/crashed re-claim re-reads the row; its persisted id is present.
    const reclaim = await claim(db, "k");
    expect(reclaim.won).toBe(false);
    expect(reclaim.resumable).toBe(true);
    expect(reclaim.row.resendBroadcastId).toBe("bc_42");

    const res = await resolveResumeBroadcastId(handle, reclaim.row);
    expect(res).toEqual({ status: "exists", broadcastId: "bc_42", source: "persisted" });
    expect(list).not.toHaveBeenCalled();
  });
});

// Sanity: ensure the db wrapper is the real one (not accidentally importing app code).
describe("isolation", () => {
  it("uses the SDK's own NamespacedDb", () => {
    const { pool } = claimsPool();
    expect(createDb(pool, "prod")).toBeInstanceOf(NamespacedDb);
  });
});
