import "server-only";

import type { CreateEmailOptions } from "resend";

import type { Envoy } from "../config.js";
import type { ConsentMirror, Stream } from "../consent/mirror.js";
import { buildListUnsubscribeHeaders } from "../consent/unsubscribe.js";
import {
  generateOrHarvestSlots,
  type GeneratedSlots,
} from "../agent/session.js";
import type { Sequence, SequenceStep } from "./sequence.js";

// Drip engine — run one due step: gate → generate-or-harvest → send → advance (U8 / origin
// R12–R16, R23). The cron tick (U9) selects due steps under an atomic claim and calls `runDripStep`
// per claimed contact. Two no-double-send guards work together (R21): the cron row claim protects
// step SELECTION; the U8 inflight-marker/harvest (here) protects a generation that times out
// mid-flight and is re-claimed next tick — it harvests the prior session, never re-generates or
// re-sends.
//
// FAIL-SAFE (R16): every failure path leaves the step DUE for a later tick and sends NOTHING empty.
// A generation that produces no usable slots, an agent error, a suppressed contact mid-flight, a
// disabled Resend key, or a Resend send error all return a non-`sent` outcome WITHOUT advancing the
// enrollment or marking the step sent. The step is retried next tick. Nothing is ever sent with
// missing slots, and nothing is silently dropped.

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
   * session for this exact step — harvest it, never fork a second billed one.
   */
  agentSessionId: string | null;
  /** When the current step became eligible (`sdk_enrollments.next_run_at`). Null ⇒ eligible now. */
  nextRunAt: Date | string | null;
}

/** Why a step did not send (when `sent` is false). */
export type DripSkipReason =
  | "not_due" // the step's wait hasn't elapsed yet
  | "suppressed" // mirror gate denied
  | "resend_disabled" // no Resend key — silent no-op (R43)
  | "deferred" // a prior session is still running — retry next tick, no second billed session
  | "generation_failed" // agent produced no usable slots / errored — leave due (R16)
  | "send_failed"; // Resend refused/threw — leave due (R16)

/** Outcome of {@link runDripStep}. */
export type DripStepResult =
  | { sent: true; emailId: string; advancedTo: number; completed: boolean }
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
}

/** Resolve the From address: explicit stream default wins; fail loud if neither is configured. */
function resolveFrom(envoy: Envoy, stream: Stream): string {
  const streamDefault = envoy.config.streams[stream]?.from;
  if (typeof streamDefault === "string" && streamDefault.trim().length > 0) {
    return streamDefault;
  }
  throw new Error(
    `[@envoy/sdk] drip step has no From address: configure streams.${stream}.from at createEnvoy time.`,
  );
}

/** Convert `waitDays` against the cron clock into an eligibility check. `0` ⇒ eligible immediately. */
function isWaitElapsed(step: SequenceStep, nextRunAt: Date | string | null, now: Date): boolean {
  if (nextRunAt === null || nextRunAt === undefined) {
    // No scheduled time recorded: a 0-wait step is eligible; a positive-wait step is only eligible
    // if there is no gating time (the tick is expected to set next_run_at on advance).
    return step.waitDays <= 0;
  }
  const due = nextRunAt instanceof Date ? nextRunAt : new Date(nextRunAt);
  return due.getTime() <= now.getTime();
}

/**
 * Persist the inflight session marker on the step row BEFORE the billed turn. This is the SDK's
 * reimplementation of the `onSessionCreated` contract: a crash after this write but before the send
 * leaves a resumable marker; a re-claim harvests it.
 */
async function markInflight(envoy: Envoy, stepId: DueStep["stepId"], sessionId: string): Promise<void> {
  await envoy.db.execWrite(
    `UPDATE sdk_steps
       SET agent_session_id = $3, updated_at = NOW()
     WHERE namespace = $1 AND id = $2`,
    [envoy.db.namespace, stepId, sessionId],
  );
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
  emailId: string,
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

/** Record a generation/send failure on the step (attempt count + last error) WITHOUT advancing —
 * the step stays due (R16). Best-effort: a bookkeeping write failure never masks the real reason. */
async function recordFailure(
  envoy: Envoy,
  stepId: DueStep["stepId"],
  reason: string,
): Promise<void> {
  try {
    await envoy.db.execWrite(
      `UPDATE sdk_steps
         SET attempts = attempts + 1, last_error = $3, updated_at = NOW()
       WHERE namespace = $1 AND id = $2`,
      [envoy.db.namespace, stepId, reason.slice(0, 500)],
    );
  } catch {
    /* bookkeeping only — the engine's return value is the source of truth */
  }
}

/**
 * Run one due drip step (R12–R16, R23). Order is load-bearing:
 *
 *   1. Resolve the current step from the sequence; an out-of-range index ⇒ complete the enrollment.
 *   2. Honor the wait (R15) — a not-yet-eligible step is skipped (`not_due`), nothing touched.
 *   3. GATE against the mirror (R26) — a suppressed contact is never sent (`suppressed`).
 *   4. Resolve From — fail loud (caller's fail-soft wraps this) if neither default is configured.
 *   5. Generate-or-harvest the declared slots (R14/R23). A re-claim with a `running` prior session
 *      DEFERS (no second billed session); a `completed` one is harvested. A failure leaves the step
 *      due (`generation_failed`) — NOTHING is sent.
 *   6. No Resend key ⇒ silent no-op (`resend_disabled`, R43) — the step stays due.
 *   7. `emails.send({ template: { id, variables }, headers: List-Unsubscribe }, { idempotencyKey })`
 *      — the idempotency key is the REQUEST OPTION (`Idempotency-Key` header), never a body field.
 *   8. Only on a confirmed send: mark the step sent + advance the enrollment (R16). A send failure
 *      leaves the step due (`send_failed`).
 */
export async function runDripStep(
  envoy: Envoy,
  sequence: Sequence,
  due: DueStep,
  config: DripEngineConfig,
  now: Date = new Date(),
): Promise<DripStepResult> {
  const stream: Stream = config.stream ?? "digest";

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
  if (!isWaitElapsed(step, due.nextRunAt, now)) {
    return { sent: false, reason: "not_due" };
  }

  // 3. Gate FIRST (R26). The drip step's topic is the sequence key (one topic per sequence).
  const topicKey = due.sequenceKey;
  const allowed = await config.mirror.gate(due.email, topicKey, stream);
  if (!allowed) {
    return { sent: false, reason: "suppressed" };
  }

  // 4. Resolve From (fail loud — the cron tick's per-contact try/catch turns this into fail-soft).
  const from = resolveFrom(envoy, stream);

  // 5. Generate or harvest the declared slots (R14/R23). Only allow-listed contact fields reach the
  //    agent (R44). The marker is persisted to the step row BEFORE the billed turn.
  let slots: GeneratedSlots = {};
  if (step.aiSlots.length > 0) {
    const gen = await generateOrHarvestSlots({
      agentId: requireAgent(envoy).agentId,
      environmentId: requireAgent(envoy).environmentId,
      aiSlots: step.aiSlots,
      brief: step.brief,
      contactData: due.data,
      aiFieldAllowList: envoy.config.aiFieldAllowList,
      resumeSessionId: due.agentSessionId,
      onSessionCreated: (sessionId) => markInflight(envoy, due.stepId, sessionId),
      timeoutMs: config.agentTimeoutMs,
    });
    if (gen.kind === "deferred") {
      return { sent: false, reason: "deferred" };
    }
    if (gen.kind === "failed") {
      await recordFailure(envoy, due.stepId, gen.reason);
      return { sent: false, reason: "generation_failed", detail: gen.reason };
    }
    slots = gen.slots;
  }

  // 6. No Resend key ⇒ silent no-op; the step stays due (R43). Checked AFTER generation so a
  //    harvested session isn't wasted, but BEFORE building headers/sending.
  const client = envoy.resend.client();
  if (!envoy.resend.enabled || client === null) {
    return { sent: false, reason: "resend_disabled" };
  }

  // 7. RFC 8058 one-click List-Unsubscribe (R33). Throws on a non-https base URL.
  const unsubHeaders = buildListUnsubscribeHeaders(
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
      ...(Object.keys(slots).length > 0 ? { variables: slots } : {}),
    },
    headers: {
      "List-Unsubscribe": unsubHeaders["List-Unsubscribe"],
      "List-Unsubscribe-Post": unsubHeaders["List-Unsubscribe-Post"],
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
    await recordFailure(envoy, due.stepId, reason);
    return { sent: false, reason: "send_failed", detail: reason };
  }

  const { data, error } = response;
  if (error || !data) {
    const reason = `emails.send failed: ${error?.message ?? "unknown error"}`;
    await recordFailure(envoy, due.stepId, reason);
    return { sent: false, reason: "send_failed", detail: reason };
  }

  // 8. Confirmed send — mark sent + advance (R16). This is the ONLY place state moves forward.
  const { advancedTo, completed } = await advance(envoy, due, sequence, data.id, now);
  return { sent: true, emailId: data.id, advancedTo, completed };
}

/** Require the agent to be configured before an AI step runs. A drip step that declares slots needs
 * an agent; surfacing this loud (rather than silently sending an un-personalized email) is R45. */
function requireAgent(envoy: Envoy): { agentId: string; environmentId: string } {
  const agent = envoy.config.agent;
  if (!agent) {
    throw new Error(
      "[@envoy/sdk] a drip step declares aiSlots but no `agent` is configured at createEnvoy time (R45).",
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
  data: Record<string, unknown> | null;
}

/** The step row (`id` + inflight marker) the tick ensures exists for the enrollment's current step. */
interface StepRow {
  id: number | string;
  agent_session_id: string | null;
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
  /** How many failed (generation_failed / send_failed / tick_error) — left due for a later tick. */
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
         RETURNING id, contact, sequence_key, current_step, next_run_at, data
      )
      SELECT id, contact, sequence_key, current_step, next_run_at, data FROM claimed`,
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
     RETURNING id, agent_session_id`,
    [envoy.db.namespace, enrollmentId, stepIndex],
  );
  const insertedRow = inserted.rows[0];
  if (insertedRow) return insertedRow;

  // Conflict path: the row already existed (a re-claim of the same step), so `DO NOTHING` returned
  // nothing. SELECT it back ONLY here — this fallback runs solely for already-existing rows, so the
  // prior tick's inflight `agent_session_id` survives and is harvested (the U8 second guard).
  const { rows } = await envoy.db.query<StepRow>(
    `SELECT id, agent_session_id
       FROM sdk_steps
      WHERE namespace = $1 AND enrollment_id = $2 AND step_index = $3`,
    [envoy.db.namespace, enrollmentId, stepIndex],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      `[@envoy/sdk] step row for enrollment ${String(enrollmentId)} step ${stepIndex} not found after upsert`,
    );
  }
  return row;
}

/** Bucket a single outcome into the running tick tallies. */
function tally(result: DripTickItem["result"]): "sent" | "skipped" | "failed" {
  if (result.sent) return "sent";
  if (result.reason === "generation_failed" || result.reason === "send_failed" || result.reason === "tick_error") {
    return "failed";
  }
  return "skipped";
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
        nextRunAt: row.next_run_at,
      };

      const result = await runDripStep(envoy, sequence, due, config, now);
      items.push({ enrollmentId: row.id, email, sequenceKey, stepIndex, result });
    } catch (err) {
      // Per-contact fail-soft (R21): never let one enrollment abort the tick. Redact before
      // surfacing — no recipient address or secret in the detail (R43).
      const detail = err instanceof Error ? err.message : "unknown tick error";
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
