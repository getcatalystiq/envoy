import { describe, expect, it } from "vitest";

import {
  rowToSequence,
  readSequenceDef,
  upsertSequenceDef,
  deleteSequenceDef,
  listSequenceDefs,
  countActiveEnrollments,
} from "@sdk/drip/store.js";
import { defineSequence, SequenceDefinitionError, type SequenceStep } from "@sdk/drip/sequence.js";
import { createDb, type SdkPool, type SdkQueryResult } from "@sdk/db/pool.js";

// U-S1 — the sequence-definition STORE. A fake pg pool backs sdk_sequence_defs (+ history) and a
// seeded sdk_enrollments, dispatching by SQL shape — no real DB (matches the SDK's other DB tests).

const FOUR_STEPS: SequenceStep[] = [
  { templateId: "tmpl-welcome", waitDays: 0, aiSlots: ["WELCOME_BODY"], brief: "welcome" },
  { templateId: "tmpl-elig", waitDays: 2, aiSlots: ["NUDGE_BODY"], brief: "nudge" },
  { templateId: "tmpl-edu", waitDays: 5, aiSlots: ["EDU_BODY"], brief: "educate" },
  { templateId: "tmpl-consult", waitDays: 9, aiSlots: ["CONSULT_BODY"], brief: "consult" },
];

interface DefRow {
  namespace: string;
  sequence_key: string;
  steps: unknown;
  version: number;
  updated_at: string;
}
interface EnrollSeed {
  namespace: string;
  sequence_key: string;
  current_step: number;
  status: string;
}

/** SQL-dispatched fake pool over an in-memory defs map + history list + seeded enrollments. */
function fakePool(opts: { enrollments?: EnrollSeed[] } = {}): {
  pool: SdkPool;
  defs: Map<string, DefRow>;
  history: Array<{ sequence_key: string; version: number; actor: string | null; steps: unknown }>;
} {
  const defs = new Map<string, DefRow>();
  const history: Array<{ sequence_key: string; version: number; actor: string | null; steps: unknown }> = [];
  const enrollments = opts.enrollments ?? [];
  const k = (ns: string, key: string) => `${ns}|${key}`;

  const pool: SdkPool = {
    async query<T = Record<string, unknown>>(
      text: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<SdkQueryResult<T>> {
      const sql = text.replace(/\s+/g, " ").trim();
      const p = params as unknown[];

      if (sql.startsWith("WITH up AS")) {
        // Atomic upsert + history (one CTE statement). Params: [ns, key, stepsJson, actor].
        const [ns, key, stepsJson, actor] = p as [string, string, string, string | null];
        const existing = defs.get(k(ns, key));
        const version = existing ? existing.version + 1 : 1;
        defs.set(k(ns, key), {
          namespace: ns,
          sequence_key: key,
          steps: stepsJson, // stored as the JSON string the writer passed (parseSteps undoes it)
          version,
          updated_at: "2026-06-23T00:00:00.000Z",
        });
        history.push({ sequence_key: key, version, actor, steps: stepsJson });
        return { rows: [{ version }] as T[] };
      }
      if (sql.startsWith("SELECT steps FROM sdk_sequence_defs")) {
        const [ns, key] = p as [string, string];
        const row = defs.get(k(ns, key));
        return { rows: row ? ([{ steps: row.steps }] as T[]) : [] };
      }
      if (sql.startsWith("DELETE FROM sdk_sequence_defs")) {
        const [ns, key] = p as [string, string];
        const had = defs.delete(k(ns, key));
        return { rows: had ? ([{ id: 1 }] as T[]) : [] };
      }
      if (sql.startsWith("SELECT sequence_key, version, updated_at FROM sdk_sequence_defs")) {
        const [ns] = p as [string];
        const rows = [...defs.values()]
          .filter((r) => r.namespace === ns)
          .sort((a, b) => a.sequence_key.localeCompare(b.sequence_key))
          .map((r) => ({ sequence_key: r.sequence_key, version: r.version, updated_at: r.updated_at }));
        return { rows: rows as T[] };
      }
      if (sql.startsWith("SELECT current_step, COUNT(*)::int")) {
        const [ns, key] = p as [string, string];
        const byStep = new Map<number, number>();
        for (const e of enrollments) {
          if (e.namespace === ns && e.sequence_key === key && e.status === "active") {
            byStep.set(e.current_step, (byStep.get(e.current_step) ?? 0) + 1);
          }
        }
        return { rows: [...byStep.entries()].map(([current_step, n]) => ({ current_step, n })) as T[] };
      }
      throw new Error(`fakePool: unhandled SQL: ${sql}`);
    },
  };
  return { pool, defs, history };
}

describe("sequence-definition store (U-S1)", () => {
  it("rowToSequence round-trips stored steps to a frozen Sequence identical to defineSequence", () => {
    const seq = rowToSequence("onboarding", JSON.stringify(FOUR_STEPS));
    expect(seq).toEqual(defineSequence({ key: "onboarding", steps: FOUR_STEPS }));
    expect(seq.steps).toHaveLength(4);
    expect(Object.isFrozen(seq)).toBe(true);
    expect(Object.isFrozen(seq.steps)).toBe(true);
    // aiSlots order + brief preserved exactly
    expect(seq.steps[0].aiSlots).toEqual(["WELCOME_BODY"]);
    expect(seq.steps[3].brief).toBe("consult");
    // also works when the driver already parsed the JSONB into an array
    expect(rowToSequence("onboarding", FOUR_STEPS)).toEqual(seq);
  });

  it("rowToSequence fails loud on a malformed stored row", () => {
    expect(() => rowToSequence("x", JSON.stringify([{ templateId: "", waitDays: 0, aiSlots: [], brief: "" }]))).toThrow(
      SequenceDefinitionError,
    );
    expect(() => rowToSequence("x", JSON.stringify([{ templateId: "t", waitDays: -1, aiSlots: [], brief: "" }]))).toThrow(
      SequenceDefinitionError,
    );
    expect(() =>
      rowToSequence("x", JSON.stringify([{ templateId: "t", waitDays: 0, aiSlots: ["A", "A"], brief: "b" }])),
    ).toThrow(SequenceDefinitionError);
    expect(() => rowToSequence("x", JSON.stringify([]))).toThrow(SequenceDefinitionError);
    // a corrupt JSON string surfaces as SequenceDefinitionError (the documented type), not a raw SyntaxError
    expect(() => rowToSequence("x", "{not valid json")).toThrow(SequenceDefinitionError);
  });

  it("upsert inserts then increments version, and appends a history row each save", async () => {
    const { pool, history } = fakePool();
    const db = createDb(pool, "prod");
    const v1 = await upsertSequenceDef(db, { key: "onboarding", steps: FOUR_STEPS, actor: "user-1" });
    expect(v1).toBe(1);
    const v2 = await upsertSequenceDef(db, { key: "onboarding", steps: FOUR_STEPS.slice(0, 3), actor: "user-2" });
    expect(v2).toBe(2);
    expect(history.map((h) => [h.version, h.actor])).toEqual([
      [1, "user-1"],
      [2, "user-2"],
    ]);
  });

  it("read returns a frozen Sequence for a stored key, undefined for an unknown key", async () => {
    const { pool } = fakePool();
    const db = createDb(pool, "prod");
    expect(await readSequenceDef(db, "onboarding")).toBeUndefined();
    await upsertSequenceDef(db, { key: "onboarding", steps: FOUR_STEPS });
    const seq = await readSequenceDef(db, "onboarding");
    expect(seq?.steps).toHaveLength(4);
    expect(await readSequenceDef(db, "nope")).toBeUndefined();
  });

  it("isolates namespaces — a write under prod is invisible under staging", async () => {
    const { pool } = fakePool();
    const prod = createDb(pool, "prod");
    const staging = createDb(pool, "staging");
    await upsertSequenceDef(prod, { key: "onboarding", steps: FOUR_STEPS });
    expect(await readSequenceDef(prod, "onboarding")).toBeDefined();
    expect(await readSequenceDef(staging, "onboarding")).toBeUndefined();
  });

  it("delete removes the row; list returns key + version", async () => {
    const { pool } = fakePool();
    const db = createDb(pool, "prod");
    await upsertSequenceDef(db, { key: "onboarding", steps: FOUR_STEPS });
    await upsertSequenceDef(db, { key: "winback", steps: FOUR_STEPS.slice(0, 1) });
    expect((await listSequenceDefs(db)).map((r) => r.key)).toEqual(["onboarding", "winback"]);
    expect(await deleteSequenceDef(db, "winback")).toBe(true);
    expect(await deleteSequenceDef(db, "winback")).toBe(false);
    expect((await listSequenceDefs(db)).map((r) => r.key)).toEqual(["onboarding"]);
  });

  it("countActiveEnrollments totals active rows and breaks them down per current_step", async () => {
    const { pool } = fakePool({
      enrollments: [
        { namespace: "prod", sequence_key: "onboarding", current_step: 0, status: "active" },
        { namespace: "prod", sequence_key: "onboarding", current_step: 2, status: "active" },
        { namespace: "prod", sequence_key: "onboarding", current_step: 2, status: "active" },
        { namespace: "prod", sequence_key: "onboarding", current_step: 3, status: "completed" }, // excluded
        { namespace: "staging", sequence_key: "onboarding", current_step: 0, status: "active" }, // other ns
      ],
    });
    const db = createDb(pool, "prod");
    const counts = await countActiveEnrollments(db, "onboarding");
    expect(counts.total).toBe(3);
    expect(counts.byStep).toEqual({ 0: 1, 2: 2 });
  });
});
