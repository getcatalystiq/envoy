import { describe, expect, it, vi } from "vitest";

import { createDbSequenceRegistry, createCompositeRegistry } from "@sdk/drip/db-registry.js";
import { upsertSequenceDef } from "@sdk/drip/store.js";
import { defineSequence, type SequenceStep } from "@sdk/drip/sequence.js";
import { createDb, type SdkPool, type SdkQueryResult } from "@sdk/db/pool.js";
import type { Envoy } from "@sdk/config.js";

// U-S2 — the DB registry (sync resolve over a refreshable snapshot) + the composite registry.

const STEPS: SequenceStep[] = [
  { templateId: "tmpl-a", waitDays: 0, aiSlots: ["A_BODY"], brief: "a" },
  { templateId: "tmpl-b", waitDays: 3, aiSlots: ["B_BODY"], brief: "b" },
];

/** Fake pool backing sdk_sequence_defs: upsert + history + the loadAll SELECT. */
function fakePool(): SdkPool {
  const defs = new Map<string, { steps: string; version: number }>();
  const k = (ns: string, key: string) => `${ns}|${key}`;
  return {
    async query<T = Record<string, unknown>>(
      text: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<SdkQueryResult<T>> {
      const sql = text.replace(/\s+/g, " ").trim();
      const p = params as unknown[];
      if (sql.startsWith("WITH up AS")) {
        const [ns, key, steps] = p as [string, string, string];
        const prev = defs.get(k(ns, key));
        const version = prev ? prev.version + 1 : 1;
        defs.set(k(ns, key), { steps, version });
        return { rows: [{ version }] as T[] };
      }
      if (sql.startsWith("SELECT sequence_key, steps FROM sdk_sequence_defs")) {
        const [ns] = p as [string];
        const prefix = `${ns}|`;
        const rows = [...defs.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, v]) => ({ sequence_key: key.slice(prefix.length), steps: v.steps }));
        return { rows: rows as T[] };
      }
      throw new Error(`fakePool: unhandled SQL: ${sql}`);
    },
  };
}

function envoyWith(pool: SdkPool, ns = "prod"): Envoy {
  return { db: createDb(pool, ns) } as unknown as Envoy;
}

describe("createDbSequenceRegistry (U-S2)", () => {
  it("resolves undefined before refresh, then from the snapshot after refresh", async () => {
    const envoy = envoyWith(fakePool());
    const reg = createDbSequenceRegistry(envoy);
    expect(reg.resolve("onboarding")).toBeUndefined(); // snapshot empty until refreshed

    await upsertSequenceDef(envoy.db, { key: "onboarding", steps: STEPS });
    expect(reg.resolve("onboarding")).toBeUndefined(); // not yet refreshed
    await reg.refresh();

    const seq = reg.resolve("onboarding");
    expect(seq).toEqual(defineSequence({ key: "onboarding", steps: STEPS }));
    expect(reg.resolve("unknown")).toBeUndefined();
  });

  it("reflects a row changed between ticks on the next refresh (read-current / clamp)", async () => {
    const envoy = envoyWith(fakePool());
    const reg = createDbSequenceRegistry(envoy);
    await upsertSequenceDef(envoy.db, { key: "onboarding", steps: STEPS });
    await reg.refresh();
    expect(reg.resolve("onboarding")?.steps).toHaveLength(2);

    await upsertSequenceDef(envoy.db, { key: "onboarding", steps: STEPS.slice(0, 1) }); // shortened
    expect(reg.resolve("onboarding")?.steps).toHaveLength(2); // stale within the tick
    await reg.refresh();
    expect(reg.resolve("onboarding")?.steps).toHaveLength(1); // current after refresh
  });
});

describe("createCompositeRegistry (U-S2)", () => {
  const dbSeq = defineSequence({ key: "onboarding", steps: STEPS });
  const codeSeq = defineSequence({ key: "onboarding", steps: STEPS.slice(0, 1) });
  const codeOnly = defineSequence({ key: "winback", steps: STEPS });

  it("DB wins when a key is in both; falls back to code when DB lacks it", () => {
    const code = new Map([
      ["onboarding", codeSeq],
      ["winback", codeOnly],
    ]);
    const onDivergence = vi.fn();
    const resolve = createCompositeRegistry((key) => (key === "onboarding" ? dbSeq : undefined), code, {
      onDivergence,
    });
    expect(resolve("onboarding")).toBe(dbSeq); // DB wins
    expect(resolve("winback")).toBe(codeOnly); // code fallback
    expect(resolve("nope")).toBeUndefined();
  });

  it("warns on divergence (DB def differs from code def), but not when they match", () => {
    const onDivergence = vi.fn();
    const resolve = createCompositeRegistry((key) => (key === "onboarding" ? dbSeq : undefined), new Map([["onboarding", codeSeq]]), { onDivergence });
    resolve("onboarding");
    expect(onDivergence).toHaveBeenCalledWith("onboarding"); // dbSeq (2 steps) ≠ codeSeq (1 step)

    onDivergence.mockClear();
    const resolveSame = createCompositeRegistry((key) => (key === "onboarding" ? dbSeq : undefined), new Map([["onboarding", dbSeq]]), { onDivergence });
    resolveSame("onboarding");
    expect(onDivergence).not.toHaveBeenCalled();
  });
});
