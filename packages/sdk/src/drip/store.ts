import "server-only";

import type { NamespacedDb } from "../db/pool.js";
import { defineSequence, type Sequence, type SequenceStep } from "./sequence.js";

// U-S1 — the DB-backed sequence-definition STORE: raw read/write over sdk_sequence_defs (+ the
// append-only sdk_sequence_def_history audit), plus the active-enrollment counts the host's editor
// needs for its in-flight safety gate. Definitions are stored under (namespace, BARE sequence_key)
// — the namespace lives in the column, never prefixed onto the key (matches sdk_enrollments, so the
// engine resolves the registry with the same bare key).
//
// Validation-on-write (defineSequence shape + validateSequenceSlots network) is the CRUD layer's job
// (U-S3, crud.ts); this module is the storage primitive. The ONE invariant it enforces itself is on
// READ: rowToSequence rebuilds every row THROUGH defineSequence, so a malformed stored row fails loud
// (SequenceDefinitionError) rather than feeding the engine a bad Sequence.

/** A stored steps value is JSONB — parsed to an array by pg/Neon, or still a JSON string. Normalize. */
function parseSteps(raw: unknown): SequenceStep[] {
  const arr = typeof raw === "string" ? (JSON.parse(raw) as unknown) : raw;
  // Leave shape-validation to defineSequence (it throws SequenceDefinitionError on a non-array /
  // empty / malformed step list); here we only undo the string encoding.
  return arr as SequenceStep[];
}

/**
 * Rebuild a frozen, validated {@link Sequence} from a stored row. Re-runs `defineSequence`, so the
 * loud structural validation + `Object.freeze` the code path gets are preserved for DB rows: a bad
 * row throws `SequenceDefinitionError`, never silently yields a broken Sequence.
 */
export function rowToSequence(key: string, storedSteps: unknown): Sequence {
  return defineSequence({ key, steps: parseSteps(storedSteps) });
}

/** Lightweight listing row for an admin index (no full steps payload). */
export interface SequenceDefSummary {
  key: string;
  version: number;
  updatedAt: string;
}

/** Read one definition by BARE key. `undefined` if absent. Throws (via defineSequence) on a bad row. */
export async function readSequenceDef(db: NamespacedDb, key: string): Promise<Sequence | undefined> {
  const { rows } = await db.query<{ steps: unknown }>(
    `SELECT steps FROM sdk_sequence_defs WHERE namespace = $1 AND sequence_key = $2`,
    [db.namespace, key],
  );
  if (rows.length === 0) return undefined;
  return rowToSequence(key, rows[0].steps);
}

/**
 * Upsert a definition (BARE key) and append a history row in the same logical write. Returns the new
 * `version` (1 on insert, prior + 1 on update). The caller (U-S3 `saveSequence`) MUST have validated
 * the steps first — this is the storage primitive, not the validation gate.
 */
export async function upsertSequenceDef(
  db: NamespacedDb,
  input: { key: string; steps: readonly SequenceStep[]; actor?: string | null },
): Promise<number> {
  const stepsJson = JSON.stringify(input.steps);
  const upserted = await db.execWrite<{ version: number }>(
    `INSERT INTO sdk_sequence_defs (namespace, sequence_key, steps, version)
       VALUES ($1, $2, $3::jsonb, 1)
     ON CONFLICT (namespace, sequence_key)
       DO UPDATE SET steps = EXCLUDED.steps,
                     version = sdk_sequence_defs.version + 1,
                     updated_at = NOW()
     RETURNING version`,
    [db.namespace, input.key, stepsJson],
  );
  const version = upserted.rows[0].version;
  await db.execWrite(
    `INSERT INTO sdk_sequence_def_history (namespace, sequence_key, version, actor, steps)
       VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id`,
    [db.namespace, input.key, version, input.actor ?? null, stepsJson],
  );
  return version;
}

/** Delete a definition by BARE key. Returns whether a row was removed. In-flight enrollments on this
 *  key keep running until the engine resolves `unknown_sequence` and skips them (never dropped). */
export async function deleteSequenceDef(db: NamespacedDb, key: string): Promise<boolean> {
  const { count } = await db.execWrite(
    `DELETE FROM sdk_sequence_defs WHERE namespace = $1 AND sequence_key = $2 RETURNING id`,
    [db.namespace, key],
  );
  return count > 0;
}

/** List the definitions in this namespace (key + current version + last-edited), for an admin index. */
export async function listSequenceDefs(db: NamespacedDb): Promise<SequenceDefSummary[]> {
  const { rows } = await db.query<{ sequence_key: string; version: number; updated_at: string }>(
    `SELECT sequence_key, version, updated_at
       FROM sdk_sequence_defs
      WHERE namespace = $1
      ORDER BY sequence_key`,
    [db.namespace],
  );
  return rows.map((r) => ({ key: r.sequence_key, version: r.version, updatedAt: r.updated_at }));
}

/** Active-enrollment counts for a key: total + per-`current_step` breakdown. The host editor uses
 *  this for the in-flight hard gate (refuse a delete/reorder that would orphan active enrollments). */
export interface ActiveEnrollmentCounts {
  total: number;
  byStep: Record<number, number>;
}

export async function countActiveEnrollments(
  db: NamespacedDb,
  key: string,
): Promise<ActiveEnrollmentCounts> {
  const { rows } = await db.query<{ current_step: number; n: number }>(
    `SELECT current_step, COUNT(*)::int AS n
       FROM sdk_enrollments
      WHERE namespace = $1 AND sequence_key = $2 AND status = 'active'
      GROUP BY current_step`,
    [db.namespace, key],
  );
  const byStep: Record<number, number> = {};
  let total = 0;
  for (const r of rows) {
    byStep[r.current_step] = r.n;
    total += r.n;
  }
  return { total, byStep };
}
