import "server-only";

import type { CreateEmailOptions } from "resend";

import type { Envoy, EnvoyAgentConfig } from "../config.js";
import type { ConsentMirror, Stream } from "../consent/mirror.js";
import { buildUnsubscribeUrl } from "../consent/unsubscribe.js";
import {
  generateOrHarvestBlock,
  sanitizeContactForAgent,
  shapeAgentTarget,
  BLOCK_AGENT_MODE,
  type BlockAgentResult,
  type GeneratedSlots,
} from "../agent/session.js";
import { getTemplate } from "../resend/templates.js";
import { type Sequence, type SequenceStep, blockTypeForSlot } from "./sequence.js";

// Drip engine — run one due step: gate → generate-or-harvest → send → advance (U8 / origin
// R12–R16, R23). The cron tick (U9) selects due steps under an atomic claim and calls `runDripStep`
// per claimed contact. Two no-double-send guards work together (R21): the cron row claim protects
// step SELECTION; the U8 inflight-marker/harvest (here) protects a generation that times out
// mid-flight and is re-claimed next tick — it harvests the prior session, never re-generates or
// re-sends.
//
// FAIL-SAFE (R16): every failure path sends NOTHING empty and never advances the enrollment or marks
// the step sent. A generation that produces no usable slots, an agent error, or a Resend send error
// is RECORDED (`recordFailure`; migration 005's `sdk_steps.failed_attempts` and
// `permanent_failures`) and retried with an exponential backoff on `next_run_at` (15 min, doubling,
// at most 12 hours, counted over every recorded failure). After `maxAttempts` PERMANENT failures — an
// agent answer with no usable block, or a block still over Resend's limit after its regeneration —
// the step is marked `failed` and the enrollment `stopped` (reported once, as `stopped`, and never
// claimed again). Every other failure is TRANSIENT and backs off without counting toward the cap: a
// failed agent CALL (outage, rate limit, timeout, key) and every Resend refusal or transport error
// (a 401/403/404 or a 422 such as an invalid From address can be the account's or the template's,
// hitting every enrollment at once), so an outage or a misconfiguration never stops enrollments. Before 0.10.0 a failing
// step was retried every tick forever (one enrollment was re-sent 10,754 times). A Resend 409
// `invalid_idempotent_request` means an earlier attempt of this step was ACCEPTED (Resend stores no
// key for a request it refuses) and its answer lost: the step is marked sent and advanced. A disabled Resend key
// or a deferred session leaves the step due with no backoff. A contact PERMANENTLY suppressed (global
// unsubscribe / bounce / complaint / erasure, or an `unsubscribed` topic row) closes its enrollment
// (`suppressed`); one merely not opted in (no consent row yet, `opt_out`) is left due, as before.
//
// AI BLOCK LENGTH: Resend refuses a template variable longer than 2,000 characters
// (`RESEND_TEMPLATE_VARIABLE_MAX`), and the refusal is not a transport failure: re-sending the same
// stored block fails the same way. So every AI-written value is checked BEFORE `emails.send`; an
// over-long one counts as a failed generation: its stored session is discarded and the slot is
// regenerated ONCE in the same run; still over-long, the failure is recorded (and backed off).

/** A claimed due step the engine acts on (the cron tick joins enrollment + step and passes this). */
export interface DueStep {
  /** `sdk_enrollments.id`. */
  enrollmentId: number | string;
  /** `sdk_steps.id` for the current step row (created/looked-up by the tick). */
  stepId: number | string;
  /** The recipient email (bare; namespaced only at the DB boundary). */
  email: string;
  /** The sequence key the enrollment is scoped to. */
  sequenceKey: string;
  /** The 0-based index of the current step (`sdk_enrollments.current_step` / `sdk_steps.step_index`). */
  stepIndex: number;
  /** The contact's host `data` snapshot (`sdk_enrollments.data`) — allow-list-filtered before the agent. */
  data: Record<string, unknown>;
  /**
   * Inflight crash-resume marker (`sdk_steps.agent_session_id`). Non-null ⇒ a prior tick started a
   * session for this exact step — harvest it, never fork a second billed one. Legacy per-step marker;
   * the per-block path uses {@link DueStep.blockSessions} instead.
   */
  agentSessionId: string | null;
  /**
   * Per-slot inflight markers (`sdk_steps.block_sessions`): `{ slotName -> sessionId }`. A slot present
   * here had its session started on a prior tick — harvest that slot, never re-bill it. Empty `{}` for
   * a fresh step. This replaces the single `agentSessionId` for the per-block agent contract.
   */
  blockSessions: Record<string, string>;
  /** When the current step became eligible (`sdk_enrollments.next_run_at`). Null ⇒ not yet scheduled. */
  nextRunAt: Date | string | null;
  /**
   * `sdk_enrollments.enrolled_at`. Anchors a step whose `next_run_at` is still NULL (e.g. step 0 —
   * `enroll()` never sets `next_run_at`): a positive-wait first step fires at `enrolled_at + waitDays`,
   * so a step-0 wait in hours or days is honored instead of deadlocking.
   */
  enrolledAt: Date | string | null;
}

/** Why a step did not send (when `sent` is false). */
export type DripSkipReason =
  | "not_due" // the step's wait hasn't elapsed yet
  | "suppressed" // mirror gate denied
  | "resend_disabled" // no Resend key — silent no-op (R43)
  | "deferred" // a prior session is still running — retry next tick, no second billed session
  | "generation_failed" // agent produced no usable slots / errored / a block over the limit — backed off (R16)
  | "send_failed" // Resend refused/threw — backed off (R16)
  | "stopped"; // the step's recorded failures reached `maxAttempts`: step `failed`, enrollment `stopped`

/**
 * Resend's limit on ONE template variable's value (its 422 reads "has a 2,000 character limit per
 * value"). Measured as the JS string length (UTF-16 code units), which is never below the character
 * count, so a value that passes here is never refused for length there.
 */
export const RESEND_TEMPLATE_VARIABLE_MAX = 2000;

/** Default cap on PERMANENT failures of one step (unusable or over-long AI output) before the stop. */
export const DEFAULT_DRIP_MAX_ATTEMPTS = 8;
/** The largest `maxAttempts` a host may configure (a larger value is clamped to it). */
export const MAX_DRIP_MAX_ATTEMPTS = 1000;
/** First backoff after a recorded failure; it doubles per failure. */
export const DRIP_BACKOFF_BASE_MS = 15 * 60 * 1000;
/**
 * The longest backoff between two attempts of one step. Kept well under Resend's 24-hour
 * idempotency-key lifetime, so a send whose answer was lost is retried while its key still answers
 * 409 `invalid_idempotent_request` (read as sent), never after it expired (which would send twice).
 */
export const DRIP_BACKOFF_MAX_MS = 12 * 60 * 60 * 1000;

/** The outcomes counted as `failed` by the tick and listed in the cron handler's `failures`. */
export const FAILED_DRIP_REASONS: ReadonlySet<DripTickReason> = new Set<DripTickReason>([
  "generation_failed",
  "send_failed",
  "stopped",
  "tick_error",
]);

/** Every non-sent reason a tick item can carry: the engine's, plus the tick's own two. */
export type DripTickReason = DripSkipReason | "unknown_sequence" | "tick_error";

/** Outcome of {@link runDripStep}. */
export type DripStepResult =
  /** `emailId` is null when the send was confirmed by Resend's idempotency answer (a 409
   *  `invalid_idempotent_request`: an earlier attempt was accepted and its answer lost). */
  | { sent: true; emailId: string | null; advancedTo: number; completed: boolean }
  | { sent: false; reason: DripSkipReason; detail?: string };

/** Config the engine needs beyond the Envoy handle. */
export interface DripEngineConfig {
  /** The consent mirror to gate against (U6). */
  mirror: ConsentMirror;
  /** Absolute https landing URL the List-Unsubscribe header points at (R33). */
  unsubscribeBaseUrl: string;
  /**
   * The stream drip steps send on. Defaults to `"digest"` — drip sequences are opt-in nurture, not
   * transactional alerts. Host can override per program.
   */
  stream?: Stream;
  /** Per-call agent timeout override. */
  agentTimeoutMs?: number;
  /**
   * PERMANENT failures of one step (an agent answer with no usable block, or a block still over
   * Resend's limit after its regeneration) before the step is marked `failed` and the enrollment
   * `stopped`. Clamped to 1..{@link MAX_DRIP_MAX_ATTEMPTS}; unset or not a number is
   * {@link DEFAULT_DRIP_MAX_ATTEMPTS}. Between attempts `next_run_at` backs off exponentially from
   * {@link DRIP_BACKOFF_BASE_MS} up to {@link DRIP_BACKOFF_MAX_MS} over EVERY recorded failure; a
   * transient one (a failed agent call, any Resend refusal or transport error) never counts here.
   */
  maxAttempts?: number;
}

/** Resolve the From address: explicit stream default wins; fail loud if neither is configured. */
function resolveFrom(envoy: Envoy, stream: Stream): string {
  const streamDefault = envoy.config.streams[stream]?.from;
  if (typeof streamDefault === "string" && streamDefault.trim().length > 0) {
    return streamDefault;
  }
  throw new Error(
    `[@catalystiq/envoy-sdk] drip step has no From address: configure streams.${stream}.from at createEnvoy time.`,
  );
}

/** Convert `waitDays` against the cron clock into an eligibility check. `0` ⇒ eligible immediately. */
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function isWaitElapsed(
  step: SequenceStep,
  nextRunAt: Date | string | null,
  now: Date,
  enrolledAt: Date | string | null = null,
): boolean {
  if (nextRunAt === null || nextRunAt === undefined) {
    // No scheduled time recorded (step 0 — enroll() never sets next_run_at). A 0-wait step is eligible
    // immediately; a positive-wait step is anchored to enrolled_at so its hour/day delay is honored
    // (without this, a non-zero step-0 wait would deadlock — claimed every tick, never due). Fall back
    // to the 0-wait check only when enrolled_at is unavailable.
    if (step.waitDays <= 0) return true;
    if (enrolledAt === null || enrolledAt === undefined) return false;
    const anchor = enrolledAt instanceof Date ? enrolledAt : new Date(enrolledAt);
    return anchor.getTime() + step.waitDays * MS_PER_DAY <= now.getTime();
  }
  const due = nextRunAt instanceof Date ? nextRunAt : new Date(nextRunAt);
  return due.getTime() <= now.getTime();
}

/**
 * Persist the inflight session marker on the step row BEFORE the billed turn. This is the SDK's
 * reimplementation of the `onSessionCreated` contract: a crash after this write but before the send
 * leaves a resumable marker; a re-claim harvests it.
 */
/**
 * Persist ONE slot's inflight session id into the
 * `block_sessions` JSONB map (`{ slotName -> sessionId }`) BEFORE that slot's billed turn. A JSONB
 * merge (`||`) so a slot already persisted in the same step is not clobbered by a later slot. A crash
 * after this write but before the send leaves a per-slot resumable marker the next tick harvests.
 */
async function markBlockInflight(
  envoy: Envoy,
  stepId: DueStep["stepId"],
  slotName: string,
  sessionId: string,
): Promise<void> {
  await envoy.db.execWrite(
    `UPDATE sdk_steps
       SET block_sessions = block_sessions || jsonb_build_object($3::text, $4::text), updated_at = NOW()
     WHERE namespace = $1 AND id = $2`,
    [envoy.db.namespace, stepId, slotName, sessionId],
  );
}

/**
 * The per-variable fallback copy of a step's template, keyed by variable name — used as each AI
 * slot's `original_content` (the agent's length-anchor). Fetched once per step (the template fetch is
 * cached). A fetch failure or a disabled Resend client is non-fatal: an empty map ⇒ empty
 * `original_content` ⇒ the agent writes fresh (a thin anchor, not a hard error).
 */
async function originalContentFallbacks(
  envoy: Envoy,
  templateId: string,
): Promise<Record<string, string>> {
  if (!envoy.resend.enabled) return {};
  try {
    const tmpl = await getTemplate(envoy.resend, templateId);
    const map: Record<string, string> = {};
    for (const v of tmpl.variables) {
      map[v.key] = v.fallback === null || v.fallback === undefined ? "" : String(v.fallback);
    }
    return map;
  } catch {
    return {};
  }
}

/** Compute the absolute time the NEXT step becomes eligible from its wait. */
function nextRunAtFor(nextStep: SequenceStep | undefined, now: Date): Date | null {
  if (!nextStep) return null;
  return new Date(now.getTime() + Math.max(0, nextStep.waitDays) * 24 * 60 * 60 * 1000);
}

/**
 * Mark the current step sent and advance the enrollment to the next step (or `completed`). Done in
 * ONE place, only after a confirmed send, so a failure before this leaves the step due (R16).
 */
async function advance(
  envoy: Envoy,
  due: DueStep,
  sequence: Sequence,
  emailId: string | null,
  now: Date,
): Promise<{ advancedTo: number; completed: boolean }> {
  const nextIndex = due.stepIndex + 1;
  const completed = nextIndex >= sequence.steps.length;
  const nextRunAt = completed ? null : nextRunAtFor(sequence.steps[nextIndex], now);

  // Mark the step sent AND advance the enrollment in ONE statement so a crash can never leave the
  // step `sent` while the enrollment is still due (which would re-attempt / re-send next tick).
  // The injected pool exposes only `.query` — no transaction surface — so atomicity comes from a
  // single data-modifying CTE: the step UPDATE runs in the WITH clause, the enrollment UPDATE is
  // the outer statement, and Postgres commits them together or not at all.
  await envoy.db.execWrite(
    `WITH step_done AS (
       UPDATE sdk_steps
          SET status = 'sent', resend_email_id = $3, sent_at = NOW(),
              attempts = attempts + 1, last_error = NULL, updated_at = NOW()
        WHERE namespace = $1 AND id = $2
        RETURNING id
     )
     UPDATE sdk_enrollments
        SET current_step = $4, status = $5, next_run_at = $6, updated_at = NOW()
      WHERE namespace = $1 AND id = $7`,
    [
      envoy.db.namespace,
      due.stepId,
      emailId,
      nextIndex,
      completed ? "completed" : "active",
      nextRunAt ? nextRunAt.toISOString() : null,
      due.enrollmentId,
    ],
  );

  return { advancedTo: nextIndex, completed };
}

/** The backoff before the next attempt after the `attempts`-th recorded failure (1-based). */
export function dripBackoffMs(attempts: number): number {
  const exp = Math.max(0, Math.min(attempts - 1, 30));
  return Math.min(DRIP_BACKOFF_BASE_MS * 2 ** exp, DRIP_BACKOFF_MAX_MS);
}

/**
 * {@link dripBackoffMs} for 1, 2, … failures, up to and including the first that reaches
 * {@link DRIP_BACKOFF_MAX_MS}. The SQL indexes it at `LEAST(failed_attempts, length)`, so every later
 * failure waits the maximum: one formula, in TypeScript, whatever `maxAttempts` is.
 */
const DRIP_BACKOFF_DELAYS_MS: readonly number[] = (() => {
  const delays: number[] = [];
  for (let n = 1; ; n += 1) {
    delays.push(dripBackoffMs(n));
    if (delays[delays.length - 1]! >= DRIP_BACKOFF_MAX_MS) return Object.freeze(delays);
  }
})();

/** What {@link recordFailure} left: `stopped` once the cap is reached, else the step stays due later. */
type FailureOutcome = { stopped: boolean };

/**
 * Record a generation/send failure WITHOUT advancing (R16), in ONE statement (the `advance` CTE
 * pattern): bump the step's `failed_attempts` (every recorded failure: it drives the backoff),
 * `permanent_failures` (a failure that is not `transient`: it drives the cap), the legacy `attempts`,
 * and `last_error`; then either push the enrollment's `next_run_at` out by the backoff or, once
 * `permanent_failures` reaches `maxAttempts`, mark the step `failed` and the enrollment `stopped`
 * (`next_run_at` cleared, so it is never claimed again). Nothing moves unless the enrollment is still
 * `active` — the enrollment row is locked FIRST, so an operator's concurrent unenroll is never
 * overwritten and its step never marked.
 *
 * The backoff is anchored to the later of the tick's clock and the database's, so a failure recorded
 * late in a long tick is still backed off from when it happened. The counters are migration 005's,
 * not `attempts`: `attempts` also counts sends and every failure before 0.10.0 (one step held 10,754),
 * so capping on it would stop such a step on its first failure after the upgrade.
 *
 * Best-effort: a bookkeeping write failure never masks the real reason and reads as not stopped,
 * but is LOGGED (a host on 0.10.0 without migration 005 fails here on every failure, and would
 * otherwise retry every tick again with nothing to show why).
 */
async function recordFailure(
  envoy: Envoy,
  due: DueStep,
  reason: string,
  opts: { maxAttempts: number; transient: boolean; now: Date },
): Promise<FailureOutcome> {
  try {
    const { rows } = await envoy.db.execWrite<{ permanent_failures: number; status: string }>(
      `WITH enr AS (
         SELECT id FROM sdk_enrollments
          WHERE namespace = $1 AND id = $5 AND status = 'active'
          FOR UPDATE
       ),
       step_fail AS (
         UPDATE sdk_steps
            SET attempts = attempts + 1,
                failed_attempts = failed_attempts + 1,
                permanent_failures = permanent_failures + CASE WHEN $8::boolean THEN 0 ELSE 1 END,
                last_error = $3,
                status = CASE
                  WHEN NOT $8::boolean AND permanent_failures + 1 >= $4::int THEN 'failed' ELSE status
                END,
                updated_at = NOW()
          WHERE namespace = $1 AND id = $2 AND EXISTS (SELECT 1 FROM enr)
          RETURNING failed_attempts, permanent_failures
       )
       UPDATE sdk_enrollments e
          SET status = CASE WHEN f.permanent_failures >= $4::int AND NOT $8::boolean THEN 'stopped' ELSE e.status END,
              next_run_at = CASE
                WHEN f.permanent_failures >= $4::int AND NOT $8::boolean THEN NULL
                ELSE GREATEST($6::timestamptz, NOW())
                     + ($7::bigint[])[LEAST(f.failed_attempts, cardinality($7::bigint[]))]
                       * INTERVAL '1 millisecond'
              END,
              updated_at = NOW()
         FROM step_fail f
        WHERE e.namespace = $1 AND e.id = $5 AND e.status = 'active'
        RETURNING f.permanent_failures, e.status`,
      [
        envoy.db.namespace,
        due.stepId,
        reason.slice(0, 500),
        opts.maxAttempts,
        due.enrollmentId,
        opts.now.toISOString(),
        DRIP_BACKOFF_DELAYS_MS,
        opts.transient,
      ],
    );
    const row = rows[0];
    const stopped = row !== undefined && row.status === "stopped";
    if (stopped) {
      // Reported ONCE: a stopped enrollment is never claimed again. No recipient in the line (R43).
      // eslint-disable-next-line no-console
      console.error(
        `[@catalystiq/envoy-sdk] drip step stopped after ${String(row.permanent_failures)} failed attempts ` +
          `(seq=${due.sequenceKey} step=${due.stepIndex} enrollment=${String(due.enrollmentId)}):`,
        envoy.redact(reason),
      );
    }
    return { stopped };
  } catch (err) {
    const code = sqlStateOf(err);
    // eslint-disable-next-line no-console
    console.error(
      `[@catalystiq/envoy-sdk] drip failure could not be recorded (seq=${due.sequenceKey} step=${due.stepIndex}); ` +
        "is migration 005_step_failed_attempts.sql applied?",
      code,
    );
    // 42703 (undefined column): the host has not applied migration 005. Keep the pre-0.10.0
    // bookkeeping (attempts, last_error) and still hold the step off for an hour, so the step is not
    // retried every tick while the migration is missing.
    if (code === "42703") await recordFailureWithoutMigration(envoy, due, reason, opts.now);
    return { stopped: false };
  }
}

/** {@link recordFailure} for a database without migration 005: no counters, a flat hour's wait. */
async function recordFailureWithoutMigration(envoy: Envoy, due: DueStep, reason: string, now: Date): Promise<void> {
  try {
    await envoy.db.execWrite(
      `WITH step_fail AS (
         UPDATE sdk_steps SET attempts = attempts + 1, last_error = $3, updated_at = NOW()
          WHERE namespace = $1 AND id = $2
          RETURNING id
       )
       UPDATE sdk_enrollments
          SET next_run_at = GREATEST($5::timestamptz, NOW()) + INTERVAL '1 hour', updated_at = NOW()
        WHERE namespace = $1 AND id = $4 AND status = 'active'`,
      [envoy.db.namespace, due.stepId, reason.slice(0, 500), due.enrollmentId, now.toISOString()],
    );
  } catch {
    /* bookkeeping only */
  }
}

/** A database error's SQLSTATE (never its message, which can echo row data), else its name. */
function sqlStateOf(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof (err as { code: unknown }).code === "string") {
    return (err as { code: string }).code;
  }
  return err instanceof Error ? err.name : "unknown";
}

/**
 * The non-sent result of a recorded failure: `stopped` once the cap is reached, else `reason`.
 * `transient` (a transport error, a Resend 429 or 5xx) backs off but never stops the enrollment.
 */
async function failStep(
  envoy: Envoy,
  due: DueStep,
  reason: "generation_failed" | "send_failed",
  detail: string,
  opts: { maxAttempts: number; now: Date; transient?: boolean },
): Promise<DripStepResult> {
  const { stopped } = await recordFailure(envoy, due, detail, {
    maxAttempts: opts.maxAttempts,
    now: opts.now,
    transient: opts.transient ?? false,
  });
  return stopped ? { sent: false, reason: "stopped", detail } : { sent: false, reason, detail };
}

/** Appended to the brief for the ONE regeneration of an over-long block, so the agent knows why. */
export function overLimitNote(previousLength: number): string {
  return (
    `\n\nLENGTH LIMIT: the previous version of this block was ${previousLength} characters. ` +
    `The block must be under ${RESEND_TEMPLATE_VARIABLE_MAX} characters INCLUDING all HTML markup; ` +
    `aim for ${Math.floor(RESEND_TEMPLATE_VARIABLE_MAX * 0.75)} or fewer. Shorten it: same points, fewer words and less markup.`
  );
}

/** The length of a generated (or harvested) block over Resend's per-value limit, else `null`. */
function overLimitLength(gen: BlockAgentResult): number | null {
  if (gen.kind !== "generated" && gen.kind !== "harvested") return null;
  return gen.body.length > RESEND_TEMPLATE_VARIABLE_MAX ? gen.body.length : null;
}

/**
 * Forget ONE slot's stored session (`block_sessions - slot`), so the next generation of that slot
 * starts fresh instead of harvesting the same output again. Used when a harvested block cannot be
 * sent (over Resend's per-value limit).
 */
async function discardBlockSession(
  envoy: Envoy,
  stepId: DueStep["stepId"],
  slotName: string,
): Promise<void> {
  try {
    await envoy.db.execWrite(
      `UPDATE sdk_steps
          SET block_sessions = block_sessions - $3::text, updated_at = NOW()
        WHERE namespace = $1 AND id = $2`,
      [envoy.db.namespace, stepId, slotName],
    );
  } catch {
    // Best-effort: a marker left in place only makes the next attempt harvest (and discard) the same
    // block again. Throwing here would skip the failure's backoff and re-bill every tick.
  }
}

/**
 * Close an enrollment whose contact can never be mailed on this topic again (a global suppression,
 * or an `unsubscribed` consent row: both only ever move toward more suppression). Only an `active`
 * enrollment is moved. Without this a suppressed contact was claimed every tick forever.
 */
async function closeSuppressed(envoy: Envoy, due: DueStep): Promise<boolean> {
  try {
    const { rows } = await envoy.db.execWrite<{ id: number | string }>(
      `UPDATE sdk_enrollments
          SET status = 'suppressed', next_run_at = NULL, updated_at = NOW()
        WHERE namespace = $1 AND id = $2 AND status = 'active'
        RETURNING id`,
      [envoy.db.namespace, due.enrollmentId],
    );
    return rows.length > 0;
  } catch {
    return false; // best-effort: the contact is still not mailed; the next tick tries to close again
  }
}

/**
 * Run one due drip step (R12–R16, R23). Order is load-bearing:
 *
 *   1. Resolve the current step from the sequence; an out-of-range index ⇒ complete the enrollment.
 *   2. Honor the wait (R15) — a not-yet-eligible step is skipped (`not_due`), nothing touched.
 *   3. GATE against the mirror (R26) — a suppressed contact is never sent (`suppressed`); one that
 *      is PERMANENTLY suppressed also has its enrollment closed (`status = 'suppressed'`).
 *   4. Resolve From — fail loud (caller's fail-soft wraps this) if neither default is configured.
 *   5. Generate-or-harvest the declared slots (R14/R23). A re-claim with a `running` prior session
 *      DEFERS (no second billed session); a `completed` one is harvested. A value over Resend's
 *      per-variable limit is discarded and regenerated once. A failure is recorded and backed off
 *      (`generation_failed`, or `stopped` at the cap) — NOTHING is sent.
 *   6. No Resend key ⇒ silent no-op (`resend_disabled`, R43) — the step stays due. Answered before
 *      step 5, so nothing is generated or recorded for a step that cannot be sent.
 *   7. `emails.send({ template: { id, variables }, headers: List-Unsubscribe }, { idempotencyKey })`
 *      — the idempotency key is the REQUEST OPTION (`Idempotency-Key` header), never a body field.
 *   8. Only on a confirmed send: mark the step sent + advance the enrollment (R16). A send failure
 *      is recorded and backed off (`send_failed`, or `stopped` at the cap).
 */
export async function runDripStep(
  envoy: Envoy,
  sequence: Sequence,
  due: DueStep,
  config: DripEngineConfig,
  now: Date = new Date(),
): Promise<DripStepResult> {
  const stream: Stream = config.stream ?? "digest";
  const maxAttempts = resolveMaxAttempts(config.maxAttempts);

  // 1. Resolve the current step. An index past the end means there is nothing to send — treat the
  //    enrollment as complete (idempotent).
  const step = sequence.steps[due.stepIndex];
  if (!step) {
    await envoy.db.execWrite(
      `UPDATE sdk_enrollments SET status = 'completed', next_run_at = NULL, updated_at = NOW()
       WHERE namespace = $1 AND id = $2`,
      [envoy.db.namespace, due.enrollmentId],
    );
    return { sent: false, reason: "generation_failed", detail: "step index out of range" };
  }

  // 2. Honor the time-based wait (R15).
  if (!isWaitElapsed(step, due.nextRunAt, now, due.enrolledAt)) {
    return { sent: false, reason: "not_due" };
  }

  // 3. Gate FIRST (R26). The drip step's topic is the sequence key (one topic per sequence).
  const topicKey = due.sequenceKey;
  const decision = await config.mirror.gateDecision(due.email, topicKey, stream);
  if (decision !== "allow") {
    if (decision === "deny_permanent" && (await closeSuppressed(envoy, due))) {
      return { sent: false, reason: "suppressed", detail: "enrollment closed" };
    }
    return { sent: false, reason: "suppressed" };
  }

  // 4. Resolve From (fail loud — the cron tick's per-contact try/catch turns this into fail-soft).
  const from = resolveFrom(envoy, stream);

  // 4b. No Resend key ⇒ silent no-op; the step stays due (R43). Checked BEFORE generation (since
  //     0.10.0): a step that cannot be sent bills no agent session, and a generation that fails or
  //     runs long there is never recorded toward the attempt cap.
  const client = envoy.resend.client();
  if (!envoy.resend.enabled || client === null) {
    return { sent: false, reason: "resend_disabled" };
  }

  // 5. Generate or harvest each declared slot, ONE BLOCK PER CALL (R14/R23). The agent returns one
  //    `{body}` per slot, so we loop: shape the allow-listed contact into `target` once (R44), fetch
  //    the template's per-variable fallbacks once (the `original_content` length-anchor), then per
  //    slot derive its block_type, generate-or-harvest with that slot's marker, and accumulate.
  //    Aggregate rule: any slot defers ⇒ defer the whole step (resolved slots' sessions are persisted
  //    and harvested free next tick); any slot fails ⇒ fail (no partial send); all resolve ⇒ send.
  //    Each slot's marker is persisted to `block_sessions` BEFORE that slot's billed turn.
  const slots: GeneratedSlots = {};
  if (step.aiSlots.length > 0) {
    const agent = requireAgent(sequence);
    const safe = sanitizeContactForAgent(due.data, envoy.config.aiFieldAllowList);
    const target = shapeAgentTarget(safe);
    const fallbackByKey = await originalContentFallbacks(envoy, step.templateId);
    for (const slotName of step.aiSlots) {
      const generate = (resumeSessionId: string | undefined, lengthNote = "") =>
        generateOrHarvestBlock({
          agentId: agent.agentId,
          environmentId: agent.environmentId,
          vaultId: agent.vaultId,
          contract: {
            mode: BLOCK_AGENT_MODE,
            original_content: fallbackByKey[slotName] ?? "",
            prompt: step.brief + lengthNote,
            target,
            block_type: blockTypeForSlot(step, slotName),
          },
          resumeSessionId,
          onSessionCreated: (sessionId) => markBlockInflight(envoy, due.stepId, slotName, sessionId),
          timeoutMs: config.agentTimeoutMs,
        });
      let gen = await generate(due.blockSessions[slotName]);
      const firstLength = overLimitLength(gen);
      if (firstLength !== null) {
        // Over Resend's per-value limit: the send would be refused, and the stored session would
        // hand back the same block on every retry. Regenerate ONCE, fresh (the new session's marker
        // replaces this slot's as soon as it is created). (Sent
        // under the same Idempotency-Key as the refused attempt: a request Resend refuses for its
        // payload stores no key, which is why the incident's every retry met the same 422, never a
        // 409 — the payload differed each tick, its unsubscribe token carrying the time.)
        gen = await generate(undefined, overLimitNote(firstLength));
        const length = overLimitLength(gen);
        if (length !== null) {
          // Discard this one too, so the next attempt (after the backoff) starts fresh again.
          await discardBlockSession(envoy, due.stepId, slotName);
          return failStep(
            envoy,
            due,
            "generation_failed",
            `AI block ${slotName} is ${length} characters, over Resend's ${RESEND_TEMPLATE_VARIABLE_MAX}-character limit per value (after one regeneration)`,
            { maxAttempts, now },
          );
        }
      }
      if (gen.kind === "deferred") {
        return { sent: false, reason: "deferred" };
      }
      if (gen.kind === "failed") {
        return failStep(envoy, due, "generation_failed", gen.reason, {
          maxAttempts,
          now,
          transient: gen.transient === true,
        });
      }
      slots[slotName] = gen.body;
    }
  }

  // 6. (No Resend key was answered before generation: see 4b.)

  // 7. RFC 8058 one-click List-Unsubscribe (R33) + the in-body UNSUBSCRIBE_URL variable — both derive
  //    from ONE signed URL. The variable lets a drip template render a VISIBLE unsubscribe link;
  //    Resend's `{{{RESEND_UNSUBSCRIBE_URL}}}` is broadcast-only and stays blank on `emails.send`.
  //    Throws on a non-https base URL.
  const unsubUrl = buildUnsubscribeUrl(
    { email: due.email, topicKey, stream },
    envoy.config.unsubscribeSecret,
    config.unsubscribeBaseUrl,
  );

  // Idempotency key: stable per (enrollment, step) so a re-claimed step that already sent at the
  // transport level dedupes at Resend rather than double-sending (R21). It is the REQUEST OPTION
  // (`Idempotency-Key` header), NOT a body field.
  const idempotencyKey = `drip:${envoy.db.namespace}:${due.enrollmentId}:${due.stepIndex}`;

  const payload = {
    to: due.email,
    from,
    template: {
      id: step.templateId,
      variables: { ...slots, UNSUBSCRIBE_URL: unsubUrl },
    },
    headers: {
      "List-Unsubscribe": `<${unsubUrl}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };

  let response: Awaited<ReturnType<typeof client.emails.send>>;
  try {
    // Cast to the NAMED target type (`emails.send`'s payload `CreateEmailOptions`), not `as never`.
    // resend@6.14.0 types `CreateEmailOptions` as a union: a content arm (`RequireAtLeastOne<html|
    // text|react>` + `template?: never`) and a templated arm (`template` required + `react|html|text:
    // never`). The annotation pins our template-only payload to the templated arm. Unlike `as never`
    // — which suppressed ALL payload typechecking — `as CreateEmailOptions` is a checked assertion:
    // the payload is still verified structurally assignable to the real target, so any future drift
    // (a misspelled `to`/`from`/`headers`/`template` field) is caught. Applied identically in
    // transactional.ts.
    response = await client.emails.send(payload as CreateEmailOptions, { idempotencyKey });
  } catch (err) {
    // Transport failure — leave the step DUE (R16). Generic message, no recipient/secret leak (R43).
    const reason = `emails.send threw: ${err instanceof Error ? err.message : "unknown transport error"}`;
    return failStep(envoy, due, "send_failed", reason, { maxAttempts, now, transient: true });
  }

  const { data, error } = response;
  if (error?.name === "invalid_idempotent_request") {
    // This step's key was already used by a request Resend ACCEPTED (a refused request stores no
    // key) whose answer was lost — the email went out. Retrying could only meet this 409 again until
    // the key expires (24 h), then send it twice. Mark it sent and advance; Resend's id is unknown.
    const { advancedTo, completed } = await advance(envoy, due, sequence, null, now);
    return { sent: true, emailId: null, advancedTo, completed };
  }
  if (error || !data) {
    const reason = `emails.send failed: ${error?.message ?? "unknown error"}`;
    // Every Resend refusal is transient: none is a verdict on the generated block (the length is
    // checked above), and many are the account's or the template's (key, domain, From, variables).
    return failStep(envoy, due, "send_failed", reason, { maxAttempts, now, transient: true });
  }

  // 8. Confirmed send — mark sent + advance (R16). This is the ONLY place state moves forward.
  const { advancedTo, completed } = await advance(envoy, due, sequence, data.id, now);
  return { sent: true, emailId: data.id, advancedTo, completed };
}

/** `maxAttempts` clamped to 1..{@link MAX_DRIP_MAX_ATTEMPTS}; unset or NaN is the default. */
function resolveMaxAttempts(value: number | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return DEFAULT_DRIP_MAX_ATTEMPTS;
  return Math.min(MAX_DRIP_MAX_ATTEMPTS, Math.max(1, Math.floor(value)));
}

/** Require the running SEQUENCE to carry its own agent before an AI step runs. The agent is resolved
 * PER-SEQUENCE (sequence.agent), not from a global config — a sequence with no agent fails loud rather
 * than silently sending un-personalized copy or falling back to some other sequence's agent (R45/R9).
 * `sequence.agent` is carried through the load path (store.rowToSequence), so the live cron sees it. */
function requireAgent(sequence: Sequence): EnvoyAgentConfig {
  const agent = sequence.agent;
  if (!agent) {
    throw new Error(
      `[@catalystiq/envoy-sdk] sequence "${sequence.key}" declares an AI step (aiSlots) but has no per-sequence \`agent\` configured (R45/R9). Assign an agent to this sequence — the engine no longer falls back to a global agent.`,
    );
  }
  return agent;
}

// =============================================================================================
// U9 — drip cron tick. Find due steps under an atomic claim, run `runDripStep` per contact,
// fail-soft (origin R20, R21). No-double-send rests on TWO guards together (R21):
//   (a) the row claim here (FOR UPDATE SKIP LOCKED) protects step SELECTION — two concurrent ticks
//       never claim the same enrollment, and
//   (b) the U8 inflight-marker/harvest inside `runDripStep` protects a generation that times out
//       mid-flight and is re-claimed next tick — it harvests the prior session, never re-generates
//       or re-sends; plus the per-(enrollment, step) `Idempotency-Key` dedupes at Resend.
// =============================================================================================

/**
 * Resolves a sequence definition by key. The host registers every `defineSequence(...)` it runs and
 * passes this lookup to the tick — the SDK never persists sequence definitions (they live in host
 * code, R12), only enrollment/step STATE. An enrollment whose `sequence_key` is not registered is
 * skipped (`unknown_sequence`) rather than silently dropped — a deploy that removed a sequence still
 * in flight is a host bug we surface, not bury.
 */
export type SequenceRegistry =
  | ReadonlyMap<string, Sequence>
  | ((sequenceKey: string) => Sequence | undefined);

function resolveSequence(registry: SequenceRegistry, key: string): Sequence | undefined {
  return typeof registry === "function" ? registry(key) : registry.get(key);
}

/** A due enrollment row the claim CTE returns (snake_case straight off `sdk_enrollments`). */
interface ClaimedEnrollmentRow {
  id: number | string;
  contact: string;
  sequence_key: string;
  current_step: number;
  next_run_at: string | null;
  enrolled_at: string | null;
  data: Record<string, unknown> | null;
}

/** The step row (`id` + inflight marker) the tick ensures exists for the enrollment's current step. */
interface StepRow {
  id: number | string;
  agent_session_id: string | null;
  block_sessions: Record<string, string> | null;
}

/** Per-enrollment outcome the tick collects (one entry per CLAIMED enrollment). */
export interface DripTickItem {
  enrollmentId: number | string;
  email: string;
  sequenceKey: string;
  stepIndex: number;
  /** The engine outcome, or a tick-level skip the engine never sees. */
  result: DripStepResult | { sent: false; reason: "unknown_sequence" | "tick_error"; detail?: string };
}

/** Aggregate result of one cron tick. Counts are derived from the per-item outcomes. */
export interface DripTickResult {
  /** How many due enrollments this tick claimed (0 ⇒ nothing was due / all were locked by a peer). */
  claimed: number;
  /** How many claimed steps actually sent an email. */
  sent: number;
  /** How many were skipped (not_due / suppressed / deferred / unknown_sequence / resend_disabled). */
  skipped: number;
  /**
   * How many failed (generation_failed / send_failed / tick_error, backed off for a later tick, and
   * `stopped`, the attempt cap reached: never claimed again).
   */
  failed: number;
  /** Per-enrollment detail (bounded by `limit`). */
  items: DripTickItem[];
}

/** Options for {@link tickDrip}. */
export interface DripTickConfig extends DripEngineConfig {
  /** Max due enrollments to claim per tick (bounds one invocation's work / `maxDuration`). */
  limit?: number;
}

const DEFAULT_TICK_LIMIT = 100;

/**
 * Atomically claim up to `limit` due enrollments. Mirrors the app's `claimQueuedEmails` SKIP LOCKED
 * idiom (reimplemented, never imported): a `claimable` CTE locks due rows `FOR UPDATE SKIP LOCKED`,
 * a `claimed` CTE bumps `updated_at` (the lease touch) and returns them. Because node-postgres runs
 * a lone statement as one autocommit transaction, two overlapping ticks never lock the same row —
 * each due enrollment is handed to AT MOST ONE tick (R21). Eligibility: `status = 'active'` and the
 * wait has elapsed (`next_run_at IS NULL OR next_run_at <= now`). Newly-eligible first (`enrolled_at`
 * order) so a backlog drains fairly.
 */
async function claimDueEnrollments(
  envoy: Envoy,
  limit: number,
  now: Date,
): Promise<ClaimedEnrollmentRow[]> {
  const { rows } = await envoy.db.execWrite<ClaimedEnrollmentRow>(
    `WITH claimable AS (
        SELECT id
          FROM sdk_enrollments
         WHERE namespace = $1
           AND status = 'active'
           AND (next_run_at IS NULL OR next_run_at <= $2)
         ORDER BY enrolled_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
      ),
      claimed AS (
        UPDATE sdk_enrollments
           SET updated_at = NOW()
         WHERE namespace = $1 AND id IN (SELECT id FROM claimable)
         RETURNING id, contact, sequence_key, current_step, next_run_at, enrolled_at, data
      )
      SELECT id, contact, sequence_key, current_step, next_run_at, enrolled_at, data FROM claimed`,
    [envoy.db.namespace, now.toISOString(), limit],
  );
  return rows;
}

/**
 * Ensure a `sdk_steps` row exists for `(enrollment, stepIndex)` and return its id + inflight marker.
 * Idempotent on the `(namespace, enrollment_id, step_index)` UNIQUE: a re-claim of the same step does
 * NOT create a second row — `ON CONFLICT DO NOTHING` then read back — so the inflight `agent_session_id`
 * from a prior tick survives and is harvested (the U8 second guard). Returns the canonical row either
 * way; throws only if the read-back finds nothing (an impossible state we refuse to send into).
 */
async function ensureStepRow(
  envoy: Envoy,
  enrollmentId: number | string,
  stepIndex: number,
): Promise<StepRow> {
  // Fast path: INSERT ... ON CONFLICT DO NOTHING RETURNING. On a FIRST claim of this step the row is
  // newly inserted and `RETURNING` hands back its `id` + (null) `agent_session_id` in ONE round trip
  // — no follow-up SELECT. This collapses the old INSERT-then-SELECT N+1 (up to 200 RTT/tick) to a
  // single statement for the common first-claim case.
  const inserted = await envoy.db.execWrite<StepRow>(
    `INSERT INTO sdk_steps (namespace, enrollment_id, step_index, status)
     VALUES ($1, $2, $3, 'pending')
     ON CONFLICT (namespace, enrollment_id, step_index) DO NOTHING
     RETURNING id, agent_session_id, block_sessions`,
    [envoy.db.namespace, enrollmentId, stepIndex],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) return insertedRow;

  // Conflict path: the row already existed (a re-claim of the same step), so `DO NOTHING` returned
  // nothing. SELECT it back ONLY here — this fallback runs solely for already-existing rows, so the
  // prior tick's inflight `agent_session_id` survives and is harvested (the U8 second guard).
  const { rows } = await envoy.db.query<StepRow>(
    `SELECT id, agent_session_id, block_sessions
       FROM sdk_steps
      WHERE namespace = $1 AND enrollment_id = $2 AND step_index = $3`,
    [envoy.db.namespace, enrollmentId, stepIndex],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `[@catalystiq/envoy-sdk] step row for enrollment ${String(enrollmentId)} step ${stepIndex} not found after upsert`,
    );
  }
  return row;
}

/** Bucket a single outcome into the running tick tallies. */
function tally(result: DripTickItem["result"]): "sent" | "skipped" | "failed" {
  if (result.sent) return "sent";
  return FAILED_DRIP_REASONS.has(result.reason) ? "failed" : "skipped";
}

/**
 * Run one cron tick of the drip lane (R20, R21). The mounted cron sub-path (U9 handler) calls this
 * after CRON_SECRET auth (U4). It:
 *
 *   1. Atomically claims up to `limit` due enrollments (SKIP LOCKED) — the SELECTION guard.
 *   2. For each, resolves the sequence from the host registry (unknown ⇒ skip, never drop).
 *   3. Ensures the current step's row exists (carrying any inflight marker) and builds a `DueStep`.
 *   4. Runs `runDripStep` — generate-or-harvest → gate → send → advance, all fail-safe (R16).
 *
 * PER-CONTACT FAIL-SOFT (R21): one enrollment's thrown error (a registry callback that throws, a
 * step-row write that errors) is caught, recorded as a `tick_error` item, and the tick CONTINUES —
 * one bad contact never aborts the others. The enrollment is left due (untouched), so it retries.
 */
export async function tickDrip(
  envoy: Envoy,
  registry: SequenceRegistry,
  config: DripTickConfig,
  now: Date = new Date(),
): Promise<DripTickResult> {
  const limit = config.limit ?? DEFAULT_TICK_LIMIT;
  const claimed = await claimDueEnrollments(envoy, limit, now);

  const items: DripTickItem[] = [];
  for (const row of claimed) {
    // `sdk_enrollments.contact` stores the NAMESPACED key (enroll() wrote `namespaceKey(email)`).
    // Default `email` to the raw stored value so a fail-soft error item still carries a stable
    // diagnostic; the BARE recipient is resolved inside the try so a foreign-namespace row fails
    // only THIS contact (stripNamespace throws → caught below), never the whole tick (R21/R38).
    let email = row.contact;
    const sequenceKey = row.sequence_key;
    const stepIndex = row.current_step;

    try {
      // Strip the install namespace off the stored contact key (P0): the recipient `to:` and the
      // RFC 8058 unsubscribe token must be the BARE email, and the mirror gate namespaces the email
      // AGAIN internally — passing the already-namespaced key would double-prefix and match no
      // consent row (every send denied). A cross-namespace row throws here (R38 guard).
      email = envoy.db.stripNamespace(row.contact);

      const sequence = resolveSequence(registry, sequenceKey);
      if (!sequence) {
        items.push({
          enrollmentId: row.id,
          email,
          sequenceKey,
          stepIndex,
          result: { sent: false, reason: "unknown_sequence" },
        });
        continue;
      }

      const step = await ensureStepRow(envoy, row.id, stepIndex);
      const due: DueStep = {
        enrollmentId: row.id,
        stepId: step.id,
        email,
        sequenceKey,
        stepIndex,
        data: row.data ?? {},
        agentSessionId: step.agent_session_id,
        blockSessions: step.block_sessions ?? {},
        nextRunAt: row.next_run_at,
        enrolledAt: row.enrolled_at,
      };

      const result = await runDripStep(envoy, sequence, due, config, now);
      items.push({ enrollmentId: row.id, email, sequenceKey, stepIndex, result });
    } catch (err) {
      // Per-contact fail-soft (R21): never let one enrollment abort the tick. Redact before
      // surfacing — no recipient address or secret in the detail (R43). Log it too: a thrown step
      // (e.g. an agent-session error) otherwise vanished — counted as `failed` with no DB write and no
      // trace, making the cron look silently broken.
      const detail = envoy.redact(err instanceof Error ? err.message : "unknown tick error");
      // eslint-disable-next-line no-console
      console.error(`[@catalystiq/envoy-sdk] drip step threw (seq=${sequenceKey} step=${stepIndex}):`, detail);
      items.push({
        enrollmentId: row.id,
        email,
        sequenceKey,
        stepIndex,
        result: { sent: false, reason: "tick_error", detail },
      });
    }
  }

  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const item of items) {
    const bucket = tally(item.result);
    if (bucket === "sent") sent += 1;
    else if (bucket === "skipped") skipped += 1;
    else failed += 1;
  }

  return { claimed: claimed.length, sent, skipped, failed, items };
}
