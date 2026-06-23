import "server-only";

import type { Envoy } from "../config.js";
import { validateSequenceSlots } from "../validate.js";
import { defineSequence, type DefineSequenceInput, type Sequence } from "./sequence.js";
import {
  upsertSequenceDef,
  deleteSequenceDef,
  readSequenceDef,
  listSequenceDefs,
  countActiveEnrollments,
  type SequenceDefSummary,
  type ActiveEnrollmentCounts,
} from "./store.js";

// U-S3 — validated CRUD over the sequence-definition store. Every write runs BOTH gates the code
// path runs, reused verbatim:
//   1. defineSequence(input)              — shape gate (throws SequenceDefinitionError, no persist).
//   2. validateSequenceSlots(resend, seq) — network gate. Its outcomes (verified against validate.ts):
//        • slot GENUINELY ABSENT on a reachable Template        → throws ValidationError (no persist).
//        • Resend UNREACHABLE / unconfigured / templates.get err → throws ValidationError (no persist).
//        • Template is a DRAFT (variables:null, can't confirm)   → returns a `warning`, does NOT throw;
//          we persist and surface the warning as a `validation_deferred` signal (re-check once the
//          Template is published).
//      Consequence (accepted, narrow): during a FULL Resend outage the editor is effectively
//      read-only — a save can't confirm slots, so it throws. Saves are rare + Resend rarely fully
//      down; the SDK's deliberate fail-loud stance (validate only where Resend is reachable) is kept
//      rather than message-sniffing a fragile soft-degrade.
// Only after both gates pass do we upsert (+ append a history row). Host-facing: an admin action (or
// a future MCP write tool) calls saveSequence/deleteSequence; reads back the rest.

export interface SaveSequenceResult {
  /** The frozen, validated definition that was persisted. */
  sequence: Sequence;
  /** New row version (1 on create, prior + 1 on update). */
  version: number;
  /** Non-empty ⇒ slot validation was DEFERRED (a draft Template returned no variable list) — the def
   *  was persisted but the aiSlot⇄Template check could not be confirmed. The host surfaces these. (A
   *  fully unreachable Resend throws instead — no persist.) */
  warnings: readonly string[];
}

/**
 * Validate then persist a sequence definition (upsert by key, + history). Throws
 * `SequenceDefinitionError` on a bad shape or `ValidationError` on a genuinely-missing slot, BEFORE
 * any write. `actor` is recorded in the history row for audit.
 */
export async function saveSequence(
  envoy: Envoy,
  input: DefineSequenceInput,
  opts?: { actor?: string | null },
): Promise<SaveSequenceResult> {
  const sequence = defineSequence(input);
  // refresh:true bypasses the process-global Template-variable cache — a save explicitly wants fresh
  // Template state, so publishing a draft Template then re-saving clears a prior validation_deferred
  // warning instead of reading a stale `variables:null`. Saves are rare; the extra fetch is cheap.
  const result = await validateSequenceSlots(envoy.resend, sequence, { refresh: true });
  const version = await upsertSequenceDef(envoy.db, {
    key: sequence.key,
    steps: sequence.steps,
    actor: opts?.actor ?? null,
  });
  return { sequence, version, warnings: result.warnings };
}

/** Delete a definition. In-flight enrollments keep running until the engine resolves
 *  `unknown_sequence` and skips them (never dropped). Returns whether a row was removed. */
export async function deleteSequence(envoy: Envoy, key: string): Promise<boolean> {
  return deleteSequenceDef(envoy.db, key);
}

/** Read one definition by key (rebuilt through `defineSequence`; throws on a malformed row). */
export async function getSequence(envoy: Envoy, key: string): Promise<Sequence | undefined> {
  return readSequenceDef(envoy.db, key);
}

/** List the definitions in this namespace (key + version + last-edited), for an admin index. */
export async function listSequences(envoy: Envoy): Promise<SequenceDefSummary[]> {
  return listSequenceDefs(envoy.db);
}

/** Active-enrollment counts for a key (total + per-current_step) — the host's in-flight edit gate. */
export async function countSequenceEnrollments(envoy: Envoy, key: string): Promise<ActiveEnrollmentCounts> {
  return countActiveEnrollments(envoy.db, key);
}
