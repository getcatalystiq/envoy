import { describe, expect, it, vi } from "vitest";

import {
  read,
  due,
  advance,
  tryAdvance,
  setPaused,
  type CursorState,
} from "@sdk/broadcast/cursor.js";
import { createDb, type SdkPool } from "@sdk/db/pool.js";

// =================================================================================================
// In-memory fake `sdk_program_state` pool. Keyed on (namespace|program_key|subject_key). Models the
// statements cursor.ts issues:
//   - SELECT watermark, issue_seq, last_fired_at, paused FROM sdk_program_state WHERE ns/pk/sk  (read)
//   - INSERT … ON CONFLICT … DO UPDATE … WHERE <strictly-greater guard> RETURNING …            (advance)
//   - INSERT … ON CONFLICT … DO UPDATE SET paused … RETURNING …                                  (setPaused)
// The advance UPDATE's WHERE guard (numeric-or-text strictly-greater) is reproduced here so the
// storage-level race guard is exercised, not just the JS guard.
// =================================================================================================

interface StoredState {
  namespace: string;
  program_key: string;
  subject_key: string;
  watermark: string | null;
  issue_seq: number;
  last_fired_at: string | null;
  paused: boolean;
}

const NUMERIC = /^[0-9.eE+-]+$/;

function storageStrictlyGreater(incoming: string, current: string | null): boolean {
  if (current === null) return true;
  if (NUMERIC.test(incoming) && NUMERIC.test(current)) {
    return Number(incoming) > Number(current);
  }
  return incoming > current;
}

function statePool(): {
  pool: SdkPool;
  store: Map<string, StoredState>;
  calls: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
} {
  const store = new Map<string, StoredState>();
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];
  const k = (ns: unknown, pk: unknown, sk: unknown) => `${ns}|${pk}|${sk}`;
  const now = () => new Date().toISOString();

  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();
      const p = params ?? [];

      if (t.startsWith("SELECT") && t.includes("FROM sdk_program_state")) {
        const found = store.get(k(p[0], p[1], p[2]));
        if (!found) return { rows: [] } as never;
        return {
          rows: [
            {
              watermark: found.watermark,
              issue_seq: found.issue_seq,
              last_fired_at: found.last_fired_at,
              paused: found.paused,
            },
          ],
        } as never;
      }

      if (
        t.startsWith("INSERT INTO sdk_program_state") &&
        t.includes("(namespace, program_key, subject_key, watermark, issue_seq, last_fired_at)")
      ) {
        // advance upsert: params = [ns, pk, sk, watermark, issueSeq|null, (firedAt?)].
        // The REAL SQL (P2) no longer pre-reads to compute the seq: when issueSeq is omitted, $5 is
        // null and the seq is derived in-SQL — `1` on the INSERT value list, `issue_seq + 1` in the
        // DO UPDATE. Model that here verbatim so the fake exercises the real DB-side computation
        // rather than echoing a JS-precomputed seq.
        const key = k(p[0], p[1], p[2]);
        const watermark = p[3] as string;
        const suppliedSeq = p[4] as number | null; // null ⇒ DB computes it
        const firedAt = p.length > 5 ? (p[5] as string) : now();
        const existing = store.get(key);
        if (!existing) {
          // INSERT branch: concrete seq is the supplied value, else 1 (the first issue).
          const insertSeq = suppliedSeq ?? 1;
          const row: StoredState = {
            namespace: p[0] as string,
            program_key: p[1] as string,
            subject_key: p[2] as string,
            watermark,
            issue_seq: insertSeq,
            last_fired_at: firedAt,
            paused: false,
          };
          store.set(key, row);
          return rowResult(row);
        }
        // ON CONFLICT DO UPDATE … WHERE strictly-greater guard.
        if (storageStrictlyGreater(watermark, existing.watermark)) {
          // UPDATE branch: supplied seq, else stored issue_seq + 1.
          existing.issue_seq = suppliedSeq ?? existing.issue_seq + 1;
          existing.watermark = watermark;
          existing.last_fired_at = firedAt;
          return rowResult(existing);
        }
        // Guard rejected the UPDATE — no returned row.
        return { rows: [] } as never;
      }

      if (
        t.startsWith("INSERT INTO sdk_program_state") &&
        t.includes("(namespace, program_key, subject_key, paused)")
      ) {
        // setPaused upsert: params = [ns, pk, sk, paused]
        const key = k(p[0], p[1], p[2]);
        const paused = p[3] as boolean;
        const existing = store.get(key);
        if (!existing) {
          const row: StoredState = {
            namespace: p[0] as string,
            program_key: p[1] as string,
            subject_key: p[2] as string,
            watermark: null,
            issue_seq: 0,
            last_fired_at: null,
            paused,
          };
          store.set(key, row);
          return rowResult(row);
        }
        existing.paused = paused;
        return rowResult(existing);
      }

      return { rows: [] } as never;
    }),
  };

  function rowResult(row: StoredState) {
    return {
      rows: [
        {
          watermark: row.watermark,
          issue_seq: row.issue_seq,
          last_fired_at: row.last_fired_at,
          paused: row.paused,
        },
      ],
    } as never;
  }

  return { pool, store, calls };
}

const KEY = { programKey: "weekly", subjectKey: "default" };

// =================================================================================================
// read()
// =================================================================================================

describe("read — lazy default for an unseen key (R36)", () => {
  it("returns the default state and writes NO row for a never-seen key", async () => {
    const { pool, store } = statePool();
    const db = createDb(pool, "prod");

    const state = await read(db, KEY);

    expect(state).toEqual<CursorState>({
      watermark: null,
      issueSeq: 0,
      lastFiredAt: null,
      paused: false,
    });
    expect(store.size).toBe(0); // a pure read materializes nothing.
  });

  it("surfaces lastFiredAt for host health alerting after an advance", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");

    const fired = "2026-06-21T00:00:00.000Z";
    await advance(db, KEY, { watermark: "100", firedAt: fired });

    const state = await read(db, KEY);
    expect(state.lastFiredAt).toBe(fired);
    expect(state.watermark).toBe("100");
    expect(state.issueSeq).toBe(1);
  });

  it("normalizes a BIGINT issue_seq returned as a string", async () => {
    const { pool, store } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "5" });
    // Simulate node-postgres returning BIGINT as a string.
    const row = [...store.values()][0]!;
    (row as unknown as { issue_seq: string | number }).issue_seq = "1";

    const state = await read(db, KEY);
    expect(state.issueSeq).toBe(1);
    expect(typeof state.issueSeq).toBe("number");
  });

  it("rejects empty program/subject keys", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await expect(read(db, { programKey: "", subjectKey: "x" })).rejects.toThrow(/programKey/);
    await expect(read(db, { programKey: "x", subjectKey: "" })).rejects.toThrow(/subjectKey/);
  });
});

// =================================================================================================
// due() — the N-day timer
// =================================================================================================

describe("due — cadence timer (R36)", () => {
  const base: CursorState = { watermark: "1", issueSeq: 1, lastFiredAt: null, paused: false };
  const fixedNow = Date.parse("2026-06-21T12:00:00.000Z");
  const daysAgo = (n: number) =>
    new Date(fixedNow - n * 24 * 60 * 60 * 1000).toISOString();

  it("is true when never fired (first issue is always due)", () => {
    expect(due({ ...base, lastFiredAt: null }, { cadenceDays: 7, now: () => fixedNow })).toBe(true);
  });

  it("is false within the cadence window", () => {
    const state = { ...base, lastFiredAt: daysAgo(3) };
    expect(due(state, { cadenceDays: 7, now: () => fixedNow })).toBe(false);
  });

  it("is true once the cadence window has elapsed", () => {
    const state = { ...base, lastFiredAt: daysAgo(8) };
    expect(due(state, { cadenceDays: 7, now: () => fixedNow })).toBe(true);
  });

  it("is true exactly at the cadence boundary (>=)", () => {
    const state = { ...base, lastFiredAt: daysAgo(7) };
    expect(due(state, { cadenceDays: 7, now: () => fixedNow })).toBe(true);
  });

  it("is never due when paused, even past the cadence window", () => {
    const state = { ...base, lastFiredAt: daysAgo(30), paused: true };
    expect(due(state, { cadenceDays: 7, now: () => fixedNow })).toBe(false);
  });

  it("fires (true) when the stored lastFiredAt is unparseable, rather than stalling", () => {
    const state = { ...base, lastFiredAt: "not-a-timestamp" };
    expect(due(state, { cadenceDays: 7, now: () => fixedNow })).toBe(true);
  });

  it("throws on a zero, negative, or non-finite cadenceDays (would fire every tick)", () => {
    const state = { ...base, lastFiredAt: daysAgo(1) };
    expect(() => due(state, { cadenceDays: 0 })).toThrow(/cadenceDays/);
    expect(() => due(state, { cadenceDays: -1 })).toThrow(/cadenceDays/);
    expect(() => due(state, { cadenceDays: Number.NaN })).toThrow(/cadenceDays/);
    expect(() => due(state, { cadenceDays: Number.POSITIVE_INFINITY })).toThrow(/cadenceDays/);
  });

  it("uses Date.now by default when no clock is injected", () => {
    // lastFiredAt far in the past ⇒ due regardless of real wall clock.
    const state = { ...base, lastFiredAt: "2000-01-01T00:00:00.000Z" };
    expect(due(state, { cadenceDays: 7 })).toBe(true);
  });
});

// =================================================================================================
// advance() — moves the watermark only on a real send, strictly-greater
// =================================================================================================

describe("advance — no redundant pre-read on the common path (P2 perf)", () => {
  it("issues NO SELECT before the upsert when advancing (first advance: one INSERT, zero reads)", async () => {
    const { pool, store, calls } = statePool();
    const db = createDb(pool, "prod");

    await advance(db, KEY, { watermark: "100" });

    // The advancing path must hit the DB exactly ONCE — the upsert. No pre-read SELECT, no re-read.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.text.trim().startsWith("INSERT INTO sdk_program_state")).toBe(true);
    expect(
      calls.some((c) => c.text.trim().startsWith("SELECT") && c.text.includes("FROM sdk_program_state"))
    ).toBe(false);
    expect(store.size).toBe(1);
  });

  it("issues NO pre-read on a subsequent strictly-greater advance (one INSERT…ON CONFLICT, zero reads)", async () => {
    const { pool, calls } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "100" });
    const before = calls.length;

    await advance(db, KEY, { watermark: "200" });

    const since = calls.slice(before);
    // Exactly one statement for the second advance — the conflict-upsert. No SELECT precedes it.
    expect(since).toHaveLength(1);
    expect(since[0]!.text.trim().startsWith("INSERT INTO sdk_program_state")).toBe(true);
  });

  it("does a SINGLE re-read (not a pre-read) only when the upsert returns zero rows — to classify a rejected advance", async () => {
    const { pool, calls } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "200" });
    const before = calls.length;

    // A non-monotonic advance: the upsert's WHERE guard rejects it (zero rows), forcing exactly one
    // re-read to classify it as non-monotonic → throw.
    await expect(advance(db, KEY, { watermark: "150" })).rejects.toThrow(/strictly greater/);

    const since = calls.slice(before);
    // First the upsert (rejected → zero rows), THEN one re-read SELECT. No read BEFORE the upsert.
    expect(since[0]!.text.trim().startsWith("INSERT INTO sdk_program_state")).toBe(true);
    const reads = since.filter(
      (c) => c.text.trim().startsWith("SELECT") && c.text.includes("FROM sdk_program_state")
    );
    expect(reads).toHaveLength(1);
  });
});

describe("advance — monotonic watermark, advance-only-on-send (R36)", () => {
  it("materializes the row on first advance and records watermark/seq/firedAt", async () => {
    const { pool, store } = statePool();
    const db = createDb(pool, "prod");

    const fired = "2026-06-21T00:00:00.000Z";
    const state = await advance(db, KEY, { watermark: "100", firedAt: fired });

    expect(state.watermark).toBe("100");
    expect(state.issueSeq).toBe(1);
    expect(state.lastFiredAt).toBe(fired);
    expect(store.size).toBe(1);
  });

  it("advances on a strictly-greater numeric watermark and increments the seq by default", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");

    await advance(db, KEY, { watermark: "100" });
    const next = await advance(db, KEY, { watermark: "200" });

    expect(next.watermark).toBe("200");
    expect(next.issueSeq).toBe(2);
  });

  it("compares ISO-8601 timestamps lexicographically (strictly-greater)", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");

    await advance(db, KEY, { watermark: "2026-06-14T00:00:00.000Z" });
    const next = await advance(db, KEY, { watermark: "2026-06-21T00:00:00.000Z" });
    expect(next.watermark).toBe("2026-06-21T00:00:00.000Z");
    expect(next.issueSeq).toBe(2);
  });

  it("records a host-supplied issueSeq verbatim when provided", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    const state = await advance(db, KEY, { watermark: "100", issueSeq: 42 });
    expect(state.issueSeq).toBe(42);
  });

  // ---- Edge: non-monotonic rejected (strict-greater) ----

  it("rejects an equal watermark (same-instant re-send guard)", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "100" });
    await expect(advance(db, KEY, { watermark: "100" })).rejects.toThrow(/strictly greater/);
  });

  it("rejects a lesser watermark (clock skew / replay)", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "200" });
    await expect(advance(db, KEY, { watermark: "100" })).rejects.toThrow(/strictly greater/);
  });

  it("does not move the watermark when a non-monotonic advance is rejected", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "200", issueSeq: 1 });
    await expect(advance(db, KEY, { watermark: "150" })).rejects.toThrow();
    const state = await read(db, KEY);
    expect(state.watermark).toBe("200");
    expect(state.issueSeq).toBe(1);
  });

  // ---- Edge: null / empty watermark rejected (R45) ----

  it("rejects a null watermark (nullable ordering-column mistake, R45)", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await expect(
      advance(db, KEY, { watermark: null as unknown as string })
    ).rejects.toThrow(/non-null, non-empty string/);
  });

  it("rejects an empty-string watermark", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await expect(advance(db, KEY, { watermark: "" })).rejects.toThrow(/non-null, non-empty string/);
  });

  it("rejects a negative issueSeq", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await expect(advance(db, KEY, { watermark: "1", issueSeq: -1 })).rejects.toThrow(/issueSeq/);
  });

  it("namespaces so two installs never collide on the same (program, subject)", async () => {
    const { pool, store } = statePool();
    const prod = createDb(pool, "prod");
    const staging = createDb(pool, "staging");

    await advance(prod, KEY, { watermark: "100" });
    await advance(staging, KEY, { watermark: "100" });

    // Two distinct stored rows despite identical bare keys.
    expect(store.size).toBe(2);
    const prodState = await read(prod, KEY);
    const stagingState = await read(staging, KEY);
    expect(prodState.watermark).toBe("100");
    expect(stagingState.watermark).toBe("100");
  });
});

// =================================================================================================
// tryAdvance() — skip-zero / only-if-new path: does NOT advance, does NOT throw
// =================================================================================================

describe("tryAdvance — skip path does not advance the watermark (R36)", () => {
  it("returns advanced:false on an equal watermark without throwing or moving the watermark", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "100", issueSeq: 1 });

    const res = await tryAdvance(db, KEY, { watermark: "100" });
    expect(res.advanced).toBe(false);
    expect(res.state.watermark).toBe("100");
    expect(res.state.issueSeq).toBe(1); // unchanged.
  });

  it("returns advanced:false on a lesser watermark (only-if-new skip)", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "200", issueSeq: 3 });

    const res = await tryAdvance(db, KEY, { watermark: "150" });
    expect(res.advanced).toBe(false);
    expect(res.state.watermark).toBe("200");
    expect(res.state.issueSeq).toBe(3);
  });

  it("advances (advanced:true) when the incoming watermark IS newer", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "100" });

    const res = await tryAdvance(db, KEY, { watermark: "300" });
    expect(res.advanced).toBe(true);
    expect(res.state.watermark).toBe("300");
    expect(res.state.issueSeq).toBe(2);
  });

  it("still throws on a null/empty watermark — that is a config bug, not a skip (R45)", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await expect(tryAdvance(db, KEY, { watermark: "" })).rejects.toThrow(/non-null, non-empty/);
  });
});

// =================================================================================================
// setPaused() — host kill-switch
// =================================================================================================

describe("setPaused — pause flag gates due (R36)", () => {
  it("materializes the row and pauses; due() then returns false", async () => {
    const { pool, store } = statePool();
    const db = createDb(pool, "prod");

    const state = await setPaused(db, KEY, true);
    expect(state.paused).toBe(true);
    expect(store.size).toBe(1);

    const read1 = await read(db, KEY);
    expect(due(read1, { cadenceDays: 1 })).toBe(false);
  });

  it("unpauses an existing row without disturbing the watermark", async () => {
    const { pool } = statePool();
    const db = createDb(pool, "prod");
    await advance(db, KEY, { watermark: "100" });
    await setPaused(db, KEY, true);
    const after = await setPaused(db, KEY, false);
    expect(after.paused).toBe(false);
    expect(after.watermark).toBe("100");
  });
});
