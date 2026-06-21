import "server-only";

// Declarative broadcast program + `runIssue` convenience (U15 / origin R35).
//
// The broadcast lane ships as composable primitives (U11–U14): the send-once claim + crash-resume
// (claim.ts), the cursor watermark/cadence clock (cursor.ts), the Template→html/text render + single
// -call dispatch (render.ts), and the pre-send reconcile sweep (reconcile.ts). Those primitives carry
// the load-bearing correctness and remain exported standalone — a host that wants a custom ordering
// composes them directly.
//
// `defineBroadcastProgram` is the convenience layer on top: a declarative handle that bundles the one
// PROVEN ordering into a single `runIssue` call, so the common host never has to re-derive it. The
// canonical ordering (R35) is:
//
//   reconcile → claim/resume → render → broadcasts.create(send:true) → cursor.advance
//
// Why this order, and why it is the one to bury behind a convenience:
//   - reconcile LAST before claim/send (R29/R14): it repairs mirror↔Resend opt-state + base-Segment
//     membership immediately before the fan-out, narrowing the reconcile→fan-out consent window that
//     Resend's after-the-fact membership resolution leaves open (a carried compliance residual).
//   - claim BEFORE any send (R30/U11): the atomic claim row is the only send-once guard (broadcasts
//     have NO Resend idempotency key). A lost claim that already sent must do NOTHING; a resumable
//     lost claim (crash mid-issue) resolves the existing broadcast rather than blind-re-creating.
//   - render → send (U12): one `broadcasts.create({ html, text, send:true })` from a saved Template.
//   - advance ONLY on a real send (R36/U13): the watermark moves strictly-greater, after the send is
//     accepted — never speculatively. A skip (no new items) never advances.
//
// Per-subject fail-soft (R35): a program fans out over subjects (a single global "default" subject
// for a simple newsletter, or per-locale / per-segment subjects). `runIssue` is one subject; the host
// loops subjects itself. One subject's Resend error is folded into a typed result and NEVER thrown —
// so it cannot abort the host's loop over the other subjects. A host-contract / programming error
// (a bad render payload, a DB write failure) still throws: those are not a single recipient's blip.

import type { Envoy } from "../config.js";
import type { Stream } from "../consent/mirror.js";
import { provisionTopic } from "../resend/topics.js";
import {
  claim,
  markSent,
  persistBroadcastId,
  resolveResumeBroadcastId,
  type BroadcastClaimRow,
  type ClaimResult,
  type ResumePrecheckOptions,
} from "./claim.js";
import {
  advance,
  due as cursorDue,
  read as readCursor,
  type CursorState,
  type DueOptions,
} from "./cursor.js";
import { reconcile, type ReconcileOptions, type ReconcileSweepResult } from "./reconcile.js";
import {
  sendBroadcast,
  type BroadcastVariables,
  type SendBroadcastResult,
} from "./render.js";

/** Raised when a program DEFINITION is malformed (fail loud at definition time, mirroring
 *  {@link SequenceDefinitionError} in the drip lane). A bad `render`, a non-positive cadence, or a
 *  missing segment is a config bug surfaced at `defineBroadcastProgram` time, not at first send. */
export class BroadcastProgramError extends Error {
  constructor(message: string) {
    super(`[@envoy/sdk] ${message}`);
    this.name = "BroadcastProgramError";
  }
}

/** A `(stream, subject)` topic identity for a program subject — the unit a recipient leaves on
 *  Resend's hosted preference page (R27). `topicKeyFor(subjectKey)` returns this so a program over
 *  per-locale subjects (`"IT"`, `"FR"`) provisions one Topic per subject. */
export interface ProgramTopic {
  stream: Stream;
  subject: string;
}

/**
 * The context handed to a program's `render` for one issue of one subject. The host's `render` owns
 * the CONTENT decision (what Template, what variables, what subject line) given the items it was
 * passed and the cursor position; the SDK owns the mechanics around it.
 */
export interface RenderContext {
  /** The subject this issue is for (bare host key; e.g. `"default"`, `"IT"`). */
  subjectKey: string;
  /** The host content items the host decided are NEW for this issue (the host owns the content query
   *  — R35). May be empty; a `render` that returns `null` for an empty batch is the skip path. */
  items: ReadonlyArray<unknown>;
  /** The cursor state read just before render — `{ watermark, issueSeq, lastFiredAt, paused }`. The
   *  `render` reads `issueSeq` to label the issue and `watermark` to know the prior high-water mark. */
  cursor: CursorState;
  /** The provisioned Resend Topic id for this subject (the unsubscribe gate, KTD9). */
  topicId: string;
}

/**
 * What a program's `render` returns for one issue. Mirrors {@link SendBroadcastInput} minus the
 * mechanics the SDK fills in (`segmentId`, `topicId`, `name` are supplied by `runIssue`), PLUS the
 * `advance` payload (`watermark`/`issueSeq`/`itemIds`) so the host names the new high-water mark for
 * the SAME issue it rendered. Returning `null`/`undefined` is the explicit SKIP signal (nothing new
 * to send) — `runIssue` then neither sends nor advances.
 */
export interface RenderedIssue {
  /** Saved Resend Template id to render this issue from. */
  templateId: string;
  /** Values for the Template's declared `{{key}}` variables (merge tags stay verbatim). */
  variables?: BroadcastVariables;
  /** Sender address. Falls back to the program's `from`, then the SDK has no default (it throws). */
  from?: string;
  /** Subject line for this issue. */
  subject: string;
  replyTo?: string | string[];
  previewText?: string;
  /** Schedule instead of sending now (Resend ISO/natural-language). */
  scheduledAt?: string;
  /**
   * The new high-water mark for THIS issue — the ordering-column value of the newest item included.
   * Advanced ONLY after the send is accepted, strictly-greater (R36). A null/empty value is a host
   * contract bug (a nullable ordering column) and is rejected by `cursor.advance` (R45).
   */
  watermark: string;
  /** Issue sequence to record (host owns numbering). Defaults to `cursor.issueSeq + 1`. */
  issueSeq?: number;
  /** Content item ids included (provenance, recorded on the claim + cursor rows). */
  itemIds?: ReadonlyArray<string>;
}

/** A program's `render` callback. Async-allowed. Returns a {@link RenderedIssue}, or `null`/
 *  `undefined` to SKIP (no new content → no send, no advance). */
export type ProgramRender = (
  ctx: RenderContext
) => RenderedIssue | null | undefined | Promise<RenderedIssue | null | undefined>;

/** Inputs to {@link defineBroadcastProgram}. */
export interface DefineBroadcastProgramInput {
  /** Stable program key (the cursor + claim rows are scoped to it; namespaced by the db wrapper). */
  key: string;
  /** Target Resend Segment id (the canonical broadcast target; intersected with the Topic). */
  segmentId: string;
  /** Map a subject key to its `(stream, subject)` Topic identity. Defaults to `{ stream: "digest",
   *  subject: subjectKey }` — a single-stream newsletter. */
  topicKeyFor?: (subjectKey: string) => ProgramTopic;
  /** The N-day cadence for `due` (R36). Must be finite and positive. */
  cadenceDays: number;
  /** Default sender address used when a `render` omits `from`. */
  from?: string;
  /** The host content/subject renderer (see {@link ProgramRender}). */
  render: ProgramRender;
}

/** Why a {@link runIssue} call did NOT send (a non-error, expected no-op). */
export type IssueSkipReason =
  /** The cadence window has not elapsed since the last send (and the caller did not `force`). */
  | "not_due"
  /** This (program, subject) cursor is paused (a host kill-switch). */
  | "paused"
  /** `render` returned `null`/`undefined` — the host had nothing new to send. */
  | "empty"
  /** The claim was lost to a concurrent tick that already sent (send-once: this caller does NOT
   *  re-send). The other tick owns this issue. */
  | "claim_lost"
  /** The claim was already marked sent (a duplicate trigger after a completed issue). */
  | "already_sent";

/** The outcome of one {@link runIssue} call. Exactly one of `sent` / `skipped` / `failed` is the
 *  dominant state; `failed` is the per-subject fail-soft capture (the host loop continues). */
export interface RunIssueResult {
  /** The bare program key. */
  programKey: string;
  /** The bare subject key this issue was for. */
  subjectKey: string;
  /** The broadcast key (`programKey:subjectKey:issueSeq`) used as the claim id + Resend broadcast
   *  name. Present whenever a claim was attempted. */
  broadcastKey?: string;
  /** True iff a broadcast was accepted by Resend this call (`broadcasts.create` returned an id) OR a
   *  resumable prior attempt was resolved as already-existing and finalized. */
  sent: boolean;
  /** The Resend broadcast id, when `sent`. */
  broadcastId?: string;
  /** Set when the call was a deliberate no-op (not an error). */
  skipped?: IssueSkipReason;
  /** Set when a fail-soft error was captured (a Resend hiccup on THIS subject). The host loop must
   *  continue to the next subject; this subject retries next tick. The message is redacted (R43). */
  failed?: string;
  /** The reconcile sweep summary run before the send (present whenever reconcile ran). */
  reconcile?: ReconcileSweepResult;
  /** The cursor state after the call (advanced on a send; unchanged on a skip/fail). */
  cursor?: CursorState;
}

/**
 * A defined broadcast program — the declarative handle. Exposes:
 *   - the program's static config (`key`, `segmentId`, `cadenceDays`, …) for introspection (U16 MCP),
 *   - `runIssue(envoy, { subjectKey, items })`: the bundled, per-subject fail-soft ordering, and
 *   - the RAW primitives bound to this program's keys (`reconcile`, `claim`, `render`/`send`,
 *     `cursor.read/due/advance`) for hosts that need a custom ordering. The raw module-level
 *     primitives stay exported from the package root too (this is sugar, not a replacement).
 */
export interface BroadcastProgram {
  readonly key: string;
  readonly segmentId: string;
  readonly cadenceDays: number;
  readonly from?: string;
  /** Resolve a subject's `(stream, subject)` Topic identity. */
  topicFor(subjectKey: string): ProgramTopic;
  /** The cursor key for a subject (`{ programKey: key, subjectKey }`). */
  cursorKey(subjectKey: string): { programKey: string; subjectKey: string };
  /** The deterministic broadcast key for a subject + issue sequence (`key:subjectKey:issueSeq`). */
  broadcastKey(subjectKey: string, issueSeq: number): string;
  /** Run ONE issue for ONE subject with the canonical ordering (per-subject fail-soft). */
  runIssue(envoy: Envoy, input: RunIssueInput): Promise<RunIssueResult>;
}

/** Inputs to {@link BroadcastProgram.runIssue}. */
export interface RunIssueInput {
  /** The subject to run (defaults to `"default"` — a single-subject newsletter). */
  subjectKey?: string;
  /** The host content items the host decided are new for this issue (handed to `render`). */
  items?: ReadonlyArray<unknown>;
  /** Bypass the cadence `due` check (a host-forced manual issue). The send-once claim still guards
   *  against a double-send — `force` only skips the timer, never the claim. */
  force?: boolean;
  /** Override the reconcile sweep options for this issue (mode, budget, backoff). */
  reconcile?: ReconcileOptions;
  /** Override the crash-resume precheck knobs (max pages, retries) for this issue. */
  resume?: ResumePrecheckOptions;
  /** Injectable clock for the `due` check (tests). */
  now?: () => number;
}

const DEFAULT_SUBJECT = "default";

function assertNonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new BroadcastProgramError(`${name} is required and must be a non-empty string.`);
  }
}

/**
 * Define a broadcast program (R35). Validates loud at definition time: a missing/empty `key` or
 * `segmentId`, a non-positive `cadenceDays`, or a non-function `render` throws
 * {@link BroadcastProgramError}. Returns a frozen {@link BroadcastProgram} handle.
 *
 * The handle is pure config + bound methods — it touches no network or DB at definition time (so a
 * module that defines programs at import has no Resend/DB dependency, preserving the unset-key no-op).
 */
export function defineBroadcastProgram(input: DefineBroadcastProgramInput): BroadcastProgram {
  if (input === null || typeof input !== "object") {
    throw new BroadcastProgramError("defineBroadcastProgram requires an input object.");
  }
  assertNonEmptyString("program key", input.key);
  assertNonEmptyString("segmentId", input.segmentId);
  if (
    typeof input.cadenceDays !== "number" ||
    !Number.isFinite(input.cadenceDays) ||
    input.cadenceDays <= 0
  ) {
    throw new BroadcastProgramError(
      `program "${input.key}" requires a finite, positive cadenceDays (got ${String(input.cadenceDays)}).`
    );
  }
  if (typeof input.render !== "function") {
    throw new BroadcastProgramError(`program "${input.key}" requires a render function.`);
  }
  if (input.topicKeyFor !== undefined && typeof input.topicKeyFor !== "function") {
    throw new BroadcastProgramError(`program "${input.key}" topicKeyFor must be a function.`);
  }
  if (input.from !== undefined && (typeof input.from !== "string" || input.from.trim().length === 0)) {
    throw new BroadcastProgramError(`program "${input.key}" from must be a non-empty string when set.`);
  }

  const key = input.key;
  const segmentId = input.segmentId;
  const cadenceDays = input.cadenceDays;
  const from = input.from;
  const render = input.render;
  const topicResolver =
    input.topicKeyFor ?? ((subjectKey: string): ProgramTopic => ({ stream: "digest", subject: subjectKey }));

  function topicFor(subjectKey: string): ProgramTopic {
    const topic = topicResolver(subjectKey);
    if (topic === null || typeof topic !== "object") {
      throw new BroadcastProgramError(
        `program "${key}" topicKeyFor("${subjectKey}") must return a { stream, subject } object.`
      );
    }
    if (topic.stream !== "digest" && topic.stream !== "alert") {
      throw new BroadcastProgramError(
        `program "${key}" topicKeyFor("${subjectKey}") returned an invalid stream "${String(topic.stream)}".`
      );
    }
    assertNonEmptyString(`program "${key}" topic subject`, topic.subject);
    return { stream: topic.stream, subject: topic.subject };
  }

  function cursorKey(subjectKey: string): { programKey: string; subjectKey: string } {
    return { programKey: key, subjectKey };
  }

  function broadcastKey(subjectKey: string, issueSeq: number): string {
    return `${key}:${subjectKey}:${issueSeq}`;
  }

  const program: BroadcastProgram = {
    key,
    segmentId,
    cadenceDays,
    from,
    topicFor,
    cursorKey,
    broadcastKey,
    runIssue(envoy: Envoy, runInput: RunIssueInput = {}): Promise<RunIssueResult> {
      return runIssueImpl(envoy, {
        program: { key, segmentId, cadenceDays, from, render, topicFor, cursorKey, broadcastKey },
        input: runInput,
      });
    },
  };

  return Object.freeze(program);
}

// ----- runIssue implementation -------------------------------------------------------------------

interface RunIssueBundle {
  program: {
    key: string;
    segmentId: string;
    cadenceDays: number;
    from?: string;
    render: ProgramRender;
    topicFor: (subjectKey: string) => ProgramTopic;
    cursorKey: (subjectKey: string) => { programKey: string; subjectKey: string };
    broadcastKey: (subjectKey: string, issueSeq: number) => string;
  };
  input: RunIssueInput;
}

/**
 * The canonical ordering, per-subject fail-soft. Steps:
 *
 *   1. read cursor → 2. due/paused gate (unless `force`) → 3. reconcile (LAST pre-send consistency)
 *   → 4. provision/resolve the subject's Topic id → 5. render (skip on null) → 6. claim (send-once)
 *   → 7. send or resume → 8. persist id + markSent → 9. advance (only on send).
 *
 * A Resend error inside the send window is CAUGHT and returned as `{ failed }` (the host loop over
 * subjects continues). A programming/contract error (bad render shape, DB write failure, non-positive
 * cadence) PROPAGATES — those are not a single recipient's transient blip.
 */
async function runIssueImpl(envoy: Envoy, bundle: RunIssueBundle): Promise<RunIssueResult> {
  const { program, input } = bundle;
  const subjectKey = input.subjectKey ?? DEFAULT_SUBJECT;
  assertNonEmptyString("subjectKey", subjectKey);

  const items = input.items ?? [];
  const cursorKey = program.cursorKey(subjectKey);

  const result: RunIssueResult = {
    programKey: program.key,
    subjectKey,
    sent: false,
  };

  // 1. Read the cursor.
  const before = await readCursor(envoy.db, cursorKey);
  result.cursor = before;

  // 2. Cadence / pause gate. `force` skips the timer but never the send-once claim.
  if (before.paused) {
    result.skipped = "paused";
    return result;
  }
  if (!input.force) {
    const dueOpts: DueOptions = { cadenceDays: program.cadenceDays };
    if (input.now !== undefined) dueOpts.now = input.now;
    if (!cursorDue(before, dueOpts)) {
      result.skipped = "not_due";
      return result;
    }
  }

  // 3. Reconcile — the LAST pre-send consistency pass (R29/R14), narrowing the fan-out window. This
  // is fail-soft internally (a single contact's Resend error never aborts it); a hard DB failure
  // propagates, which is correct (a mirror we cannot write is a contract violation).
  const sweep = await reconcile(envoy, input.reconcile);
  result.reconcile = sweep;

  // 4. Resolve the subject's Topic id (the unsubscribe gate). Provisioning is idempotent + cached;
  // a cache hit is a pure read. This is a host-contract concern (a topic that cannot be addressed),
  // so a failure here PROPAGATES rather than fail-soft — it is not a per-recipient send blip.
  const topic = program.topicFor(subjectKey);
  const provisioned = await provisionTopic(envoy.db, envoy.resend, {
    stream: topic.stream,
    subject: topic.subject,
  });
  const topicId = provisioned.topicId;

  // 5. Render — the host's content decision. A `null`/`undefined` return is the explicit skip.
  const rendered = await program.render({
    subjectKey,
    items,
    cursor: before,
    topicId,
  });
  if (rendered === null || rendered === undefined) {
    result.skipped = "empty";
    return result;
  }
  validateRendered(program.key, subjectKey, rendered);

  const issueSeq = rendered.issueSeq ?? before.issueSeq + 1;
  const broadcastKey = program.broadcastKey(subjectKey, issueSeq);
  result.broadcastKey = broadcastKey;
  const itemIds = rendered.itemIds ? Array.from(rendered.itemIds) : [];
  const fromAddress = rendered.from ?? program.from;
  if (typeof fromAddress !== "string" || fromAddress.trim().length === 0) {
    throw new BroadcastProgramError(
      `program "${program.key}" issue for "${subjectKey}" has no from address ` +
        `(set program.from or return from from render).`
    );
  }

  // 6. Claim — the send-once guard (R30). Only a winner (or a resumable prior attempt) may send.
  const claimResult: ClaimResult = await claim(envoy.db, broadcastKey, { itemIds });

  if (!claimResult.won) {
    if (!claimResult.resumable) {
      // The prior attempt already sent (sent_at set). This is a duplicate trigger — do NOTHING.
      result.skipped = "already_sent";
      result.broadcastId = claimResult.row.resendBroadcastId ?? undefined;
      return result;
    }
    // A resumable lost claim — a prior attempt crashed mid-issue. Resolve whether the broadcast was
    // already accepted (persisted id, or a bounded broadcasts.list precheck) rather than re-creating
    // (the double-blast R30 forbids). This whole resume path is fail-soft (a Resend error → retry).
    return resumeIssue(envoy, {
      result,
      program,
      subjectKey,
      topicId,
      fromAddress,
      rendered,
      claimRow: claimResult.row,
      broadcastKey,
      issueSeq,
      itemIds,
      cursorKey,
      resumeOpts: input.resume,
    });
  }

  // 7–9. Dispatch (claim won → fresh send) and finalize (persist id → markSent → advance).
  return dispatchAndFinalize(envoy, {
    result,
    program,
    subjectKey,
    topicId,
    fromAddress,
    rendered,
    broadcastKey,
    issueSeq,
    itemIds,
    cursorKey,
  });
}

interface DispatchArgs {
  result: RunIssueResult;
  program: RunIssueBundle["program"];
  subjectKey: string;
  topicId: string;
  fromAddress: string;
  rendered: RenderedIssue;
  broadcastKey: string;
  issueSeq: number;
  itemIds: string[];
  cursorKey: { programKey: string; subjectKey: string };
}

/**
 * The send window: `broadcasts.create` → persist id → markSent → advance. Used by both the fresh
 * (won-claim) path and the resume-absent path (a prior attempt that crashed BEFORE Resend accepted
 * anything, so re-creating is safe — there is no accepted broadcast to double).
 *
 * Per-subject fail-soft: a Resend `broadcasts.create` error is CAPTURED as `result.failed`, not
 * thrown — the claim row stays unsent (sent_at NULL) so the next tick resumes it, the cursor did NOT
 * advance, and the host's loop over OTHER subjects continues. The post-accept writes (persist /
 * markSent / advance) are local DB writes and propagate on failure (a contract violation, not a blip).
 */
async function dispatchAndFinalize(envoy: Envoy, args: DispatchArgs): Promise<RunIssueResult> {
  const { result, program, rendered, broadcastKey, issueSeq, itemIds, cursorKey } = args;

  let sendResult: SendBroadcastResult;
  try {
    sendResult = await sendBroadcast(envoy.resend, {
      segmentId: program.segmentId,
      topicId: args.topicId,
      from: args.fromAddress,
      subject: rendered.subject,
      templateId: rendered.templateId,
      variables: rendered.variables,
      name: broadcastKey,
      ...(rendered.replyTo !== undefined ? { replyTo: rendered.replyTo } : {}),
      ...(rendered.previewText !== undefined ? { previewText: rendered.previewText } : {}),
      ...(rendered.scheduledAt !== undefined ? { scheduledAt: rendered.scheduledAt } : {}),
      send: true,
    });
  } catch (err) {
    // Fail-soft: the claim row stays unsent (sent_at NULL), so the next tick resumes it. The cursor
    // did NOT advance. Surface a redacted message; the host loop continues to the next subject.
    result.failed = envoy.redact(err instanceof Error ? err.message : String(err));
    return result;
  }

  // Persist the Resend id immediately (so a crash before markSent resumes via the id, never a list
  // scan), then mark sent.
  await persistBroadcastId(envoy.db, broadcastKey, sendResult.broadcastId);
  await markSent(envoy.db, broadcastKey, { itemIds });

  // Advance the cursor — ONLY now, on a real accepted send (R36). Strictly-greater; a null/non-
  // monotonic watermark throws (a host-contract bug, not fail-soft).
  const advanced = await advance(envoy.db, cursorKey, {
    watermark: rendered.watermark,
    issueSeq,
    itemIds,
  });

  result.sent = true;
  result.broadcastId = sendResult.broadcastId;
  result.cursor = advanced;
  result.failed = undefined;
  return result;
}

interface ResumeArgs {
  result: RunIssueResult;
  program: RunIssueBundle["program"];
  subjectKey: string;
  topicId: string;
  fromAddress: string;
  rendered: RenderedIssue;
  claimRow: BroadcastClaimRow;
  broadcastKey: string;
  issueSeq: number;
  itemIds: string[];
  cursorKey: { programKey: string; subjectKey: string };
  resumeOpts?: ResumePrecheckOptions;
}

/**
 * Resume a crashed-mid-issue claim (`sent_at IS NULL`). Resolve whether the broadcast already
 * exists in Resend (persisted id, or a bounded `broadcasts.list` precheck):
 *   - EXISTS → the prior attempt's `broadcasts.create` was already accepted. Finalize WITHOUT
 *     re-creating (persist id if the precheck found it, markSent, advance) — exactly once (R30).
 *   - ABSENT → the prior attempt crashed BEFORE Resend accepted anything; it is safe to (re-)create.
 *     Re-dispatch via {@link dispatchAndFinalize} (the same send window, no second claim).
 *
 * Per-subject fail-soft: a Resend list error or a precheck budget exhaustion (the primitive fails
 * loud by throwing) is captured as `failed` here (the claim stays unsent; the host retries next
 * tick) — the host loop is never aborted.
 */
async function resumeIssue(envoy: Envoy, args: ResumeArgs): Promise<RunIssueResult> {
  const { result, claimRow, broadcastKey, issueSeq, itemIds, cursorKey, rendered } = args;

  let resolution;
  try {
    resolution = await resolveResumeBroadcastId(
      envoy.resend,
      {
        broadcastKey: claimRow.broadcastKey,
        resendBroadcastId: claimRow.resendBroadcastId,
        createdAt: claimRow.createdAt,
      },
      args.resumeOpts
    );
  } catch (err) {
    // Fail loud is the primitive's job (budget exhaustion throws); at the program layer we capture
    // it as a per-subject failure so the host loop continues. The claim stays unsent → next tick.
    result.failed = envoy.redact(err instanceof Error ? err.message : String(err));
    return result;
  }

  if (resolution.status === "exists") {
    // The broadcast was already accepted by Resend in the prior (crashed) attempt. Finalize it:
    // persist the id (if the precheck found it), markSent, and advance — exactly once.
    if (claimRow.resendBroadcastId === null) {
      await persistBroadcastId(envoy.db, broadcastKey, resolution.broadcastId);
    }
    await markSent(envoy.db, broadcastKey, { itemIds });
    const advanced = await advance(envoy.db, cursorKey, {
      watermark: rendered.watermark,
      issueSeq,
      itemIds,
    });
    result.sent = true;
    result.broadcastId = resolution.broadcastId;
    result.cursor = advanced;
    return result;
  }

  // resolution.status === "absent": the prior attempt crashed BEFORE Resend accepted anything. Safe
  // to (re-)create — re-dispatch through the same send window (no second claim; we already hold a
  // resumable claim row).
  return dispatchAndFinalize(envoy, {
    result,
    program: args.program,
    subjectKey: args.subjectKey,
    topicId: args.topicId,
    fromAddress: args.fromAddress,
    rendered,
    broadcastKey,
    issueSeq,
    itemIds,
    cursorKey,
  });
}

function validateRendered(
  programKey: string,
  subjectKey: string,
  rendered: RenderedIssue
): void {
  if (rendered === null || typeof rendered !== "object") {
    throw new BroadcastProgramError(
      `program "${programKey}" render for "${subjectKey}" must return a RenderedIssue object or null.`
    );
  }
  if (typeof rendered.templateId !== "string" || rendered.templateId.trim().length === 0) {
    throw new BroadcastProgramError(
      `program "${programKey}" render for "${subjectKey}" must return a non-empty templateId.`
    );
  }
  if (typeof rendered.subject !== "string" || rendered.subject.length === 0) {
    throw new BroadcastProgramError(
      `program "${programKey}" render for "${subjectKey}" must return a non-empty subject.`
    );
  }
  // The watermark is the host's ordering-column value. A null/empty value is a nullable-column
  // mistake; cursor.advance also rejects it (R45), but failing here gives a program-scoped message.
  if (typeof rendered.watermark !== "string" || rendered.watermark.length === 0) {
    throw new BroadcastProgramError(
      `program "${programKey}" render for "${subjectKey}" returned a null/empty watermark — a nullable ` +
        `ordering column cannot back a monotonic broadcast cursor (R36/R45).`
    );
  }
}
