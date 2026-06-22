import { describe, expect, it, vi } from "vitest";

import { provisionTopic, topicKeyFor } from "@sdk/resend/topics.js";
import { createDb, type SdkPool } from "@sdk/db/pool.js";
import { createResendClientHandle } from "@sdk/resend/client.js";
import type { ResendClientHandle } from "@sdk/resend/client.js";

// ---------------------------------------------------------------------------------------------
// In-memory fake of the `sdk_program_state` slice the topic cache uses. It models exactly the two
// statements topics.ts issues against the cache (under program_key = "__envoy_topics__"):
//   - SELECT watermark FROM sdk_program_state WHERE namespace=$1 AND program_key=$2 AND subject_key=$3
//   - INSERT … ON CONFLICT (namespace, program_key, subject_key) DO NOTHING RETURNING watermark
// Keyed by (namespace|program_key|subject_key). Records every call for assertions.
// ---------------------------------------------------------------------------------------------

function fakeProgramStatePool() {
  const store = new Map<string, string>(); // namespace|program|subject -> watermark
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];
  const key = (p: ReadonlyArray<unknown>) => `${p[0]}|${p[1]}|${p[2]}`;

  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();
      const p = params ?? [];

      if (t.startsWith("SELECT watermark FROM sdk_program_state")) {
        const v = store.get(key(p));
        return { rows: v !== undefined ? [{ watermark: v }] : [] } as never;
      }

      if (t.startsWith("INSERT INTO sdk_program_state")) {
        const k = key(p);
        const watermark = p[3] as string;
        if (store.has(k)) {
          // Lost the claim — DO NOTHING returns no rows.
          return { rows: [] } as never;
        }
        store.set(k, watermark);
        return { rows: [{ watermark }] } as never;
      }

      return { rows: [] } as never;
    }),
  };

  return { pool, store, calls };
}

/** A Resend handle whose `topics.create` is a controllable spy. */
function fakeResend(opts?: {
  enabled?: boolean;
  error?: { message: string; statusCode: number | null; name: string };
  ids?: string[]; // successive ids returned by create
}): { handle: ResendClientHandle; create: ReturnType<typeof vi.fn> } {
  let n = 0;
  const create = vi.fn(async () => {
    if (opts?.error) {
      return { data: null, error: opts.error };
    }
    const id = opts?.ids?.[n] ?? `tp_${n + 1}`;
    n += 1;
    return { data: { id }, error: null };
  });
  const handle = createResendClientHandle(
    opts?.enabled === false ? undefined : "re_test_key"
  );
  if (opts?.enabled !== false) {
    vi.spyOn(handle, "client").mockReturnValue({
      topics: { create },
    } as never);
  }
  return { handle, create };
}

const NAMESPACE = "prod";

function setup(resendOpts?: Parameters<typeof fakeResend>[0]) {
  const { pool, store, calls } = fakeProgramStatePool();
  const db = createDb(pool, NAMESPACE);
  const { handle, create } = fakeResend(resendOpts);
  return { db, store, calls, handle, create };
}

describe("topicKeyFor", () => {
  it("joins stream and subject with a colon", () => {
    expect(topicKeyFor("digest", "IT")).toBe("digest:IT");
    expect(topicKeyFor("alert", "law-change")).toBe("alert:law-change");
  });

  it("rejects an empty subject", () => {
    expect(() => topicKeyFor("digest", "")).toThrow(/non-empty/);
  });
});

describe("provisionTopic — idempotent, cached per (stream, subject) (R27/R37)", () => {
  it("Happy: first provision creates the Resend Topic opt_in + caches the id", async () => {
    const { db, handle, create, store } = setup({ ids: ["tp_italy"] });

    const res = await provisionTopic(db, handle, { stream: "digest", subject: "IT" });

    expect(res).toEqual({ topicKey: "digest:IT", topicId: "tp_italy", created: true });
    expect(create).toHaveBeenCalledTimes(1);
    // Created opt_in (subscribe-by-default) — assert the payload Resend received.
    expect(create.mock.calls[0][0]).toMatchObject({ defaultSubscription: "opt_in" });
    // Cached into program_state under the topic key.
    expect(store.get(`${NAMESPACE}|__envoy_topics__|digest:IT`)).toBe("tp_italy");
  });

  it("Happy: a second provision returns the cached id and creates nothing", async () => {
    const { db, handle, create } = setup({ ids: ["tp_italy"] });

    const first = await provisionTopic(db, handle, { stream: "digest", subject: "IT" });
    const second = await provisionTopic(db, handle, { stream: "digest", subject: "IT" });

    expect(first.topicId).toBe("tp_italy");
    expect(second).toEqual({ topicKey: "digest:IT", topicId: "tp_italy", created: false });
    // Only ONE Resend create across both calls — the cache hit creates nothing.
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("provisions distinct topics per (stream, subject)", async () => {
    const { db, handle, create } = setup({ ids: ["tp_it", "tp_fr"] });

    const it = await provisionTopic(db, handle, { stream: "digest", subject: "IT" });
    const fr = await provisionTopic(db, handle, { stream: "digest", subject: "FR" });

    expect(it.topicId).toBe("tp_it");
    expect(fr.topicId).toBe("tp_fr");
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("Edge: a concurrent first-provision that loses the cache claim adopts the winner's id", async () => {
    // Simulate: our INSERT loses (DO NOTHING), and the SELECT-back yields the winner's id.
    const { store } = fakeProgramStatePool();
    // Pre-seed the cache row as if a concurrent provision already won.
    store.set(`${NAMESPACE}|__envoy_topics__|digest:IT`, "tp_winner");
    // But make the FIRST read (before create) miss, to force the create+claim path: we model a true
    // race by clearing then re-seeding after the first read. Simpler: wrap query to miss once.
    let firstReadDone = false;
    const racingPool: SdkPool = {
      query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
        const t = text.trim();
        const p = params ?? [];
        if (t.startsWith("SELECT watermark FROM sdk_program_state")) {
          if (!firstReadDone) {
            firstReadDone = true;
            return { rows: [] } as never; // initial cache miss → forces create
          }
          return { rows: [{ watermark: store.get(`${p[0]}|${p[1]}|${p[2]}`) ?? null }] } as never;
        }
        if (t.startsWith("INSERT INTO sdk_program_state")) {
          // Row already present (winner) → DO NOTHING returns no rows (we lost the claim).
          return { rows: [] } as never;
        }
        return { rows: [] } as never;
      }),
    };
    const db = createDb(racingPool, NAMESPACE);
    const { handle, create } = fakeResend({ ids: ["tp_loser"] });

    const res = await provisionTopic(db, handle, { stream: "digest", subject: "IT" });

    // We created our own Topic but the cache holds the winner's id; we adopt it.
    expect(create).toHaveBeenCalledTimes(1);
    expect(res.topicId).toBe("tp_winner");
  });

  it("Error: Resend unset but no cache row → throws (a topic id is required, not a no-op)", async () => {
    const { db, handle } = setup({ enabled: false });
    await expect(
      provisionTopic(db, handle, { stream: "digest", subject: "IT" })
    ).rejects.toThrow(/Resend is not configured/);
  });

  it("Edge: Resend unset but a cache hit returns the cached id without creating", async () => {
    const { pool, store } = fakeProgramStatePool();
    store.set(`${NAMESPACE}|__envoy_topics__|digest:IT`, "tp_cached");
    const db = createDb(pool, NAMESPACE);
    const { handle } = setup({ enabled: false });

    const res = await provisionTopic(db, handle, { stream: "digest", subject: "IT" });
    expect(res).toEqual({ topicKey: "digest:IT", topicId: "tp_cached", created: false });
  });

  it("Error: a Resend topics.create error throws (fails loud — provisioning is not fail-soft)", async () => {
    const { db, handle } = setup({
      error: { message: "boom", statusCode: 500, name: "application_error" },
    });
    await expect(
      provisionTopic(db, handle, { stream: "alert", subject: "law-change" })
    ).rejects.toThrow(/topics\.create failed/);
  });
});
