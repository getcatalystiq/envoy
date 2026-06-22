import "server-only";

// Config-time validation — fail loud, not at send time (U18 / origin R45).
//
// R45's contract: a host-contract mistake (a declared AI slot that does not exist on its Resend
// Template, a transactional send with no `stream`, a program backed by a NULLABLE ordering column)
// must surface as an early, actionable error at CONFIG time — never as a silent malformed send or a
// non-monotonic watermark that re-blasts content. This module is the one place those checks live.
//
// There are TWO kinds of validation, split by whether they need the network:
//
//   1. SYNCHRONOUS, NO NETWORK — runs at `define*` / call time, never touches Resend:
//        - `assertTransactionalStream(stream)`  — a transactional send (R46) MUST name a stream;
//          a missing/unknown stream is rejected before anything is sent (it scopes the
//          List-Unsubscribe token, R33). Mirrors the runtime guard in `drip/transactional.ts` but is
//          callable at config time so a host can fail at wiring, not at first send.
//        - `assertWatermarkColumnType({ column, type, nullable })` — a broadcast program declares the
//          host ordering column that backs its monotonic cursor. The SDK CANNOT read the host's
//          content tables (R38/R45), so the column's nullability is DECLARED by the host and checked
//          here: a `nullable: true` declaration is rejected at setup (a nullable column cannot back a
//          strictly-greater watermark — `cursor.advance` would otherwise throw at the first send).
//
//   2. LAZY, NETWORK — the slot ⇄ Template check. Each sequence step's declared `aiSlots` must exist
//      as variables on its referenced Resend Template. This needs `templates.get`, so it is NEVER run
//      at module load (that would make init depend on Resend reachability and break U3's unset-key
//      no-op). It fires on FIRST USE (cached per Template id) or via an explicit `envoy.validate()`.
//      A Template whose `variables` come back `null` (a draft / variable-less Template) is treated as
//      "CANNOT CONFIRM" → a warning, not a hard error (we cannot prove the slot is absent). A Template
//      with a concrete variable list that is MISSING a declared slot is a hard error.
//
// Patterns reimplemented (never imported from the app, R48): U3's loud config-validation style
// (`EnvoyConfigError`-shaped, secret-free messages) and the `templates.get` structural-client idiom
// from `resend/templates.ts` (so the raw `variables: null` signal survives — `getTemplate` normalizes
// it to `[]`, which would erase the draft-vs-empty distinction this check depends on).

import type { Envoy } from "./config.js";
import { STREAMS, type Stream } from "./consent/mirror.js";
import type { ResendClientHandle } from "./resend/client.js";
import type { Sequence } from "./drip/sequence.js";

/**
 * Raised when a host-contract validation fails loud at config time (R45). Carries no secret values;
 * the message names the offending field/slot/column and what to fix. Distinct from
 * `SequenceDefinitionError` (shape) and `cursor.advance`'s runtime guard (the last-line defense): a
 * `ValidationError` is the EARLY, actionable surfacing of the same class of mistake.
 */
export class ValidationError extends Error {
  constructor(message: string) {
    super(`[@catalystiq/envoy-sdk] ${message}`);
    this.name = "ValidationError";
  }
}

// =================================================================================================
// 1. Synchronous, no-network checks
// =================================================================================================

/**
 * Assert a transactional send names a valid `stream` (R45/R46). A transactional email's
 * `List-Unsubscribe` token is stream-scoped (R33), so a send with no stream cannot carry a working
 * one-click opt-out — it must be rejected at CONFIG time, never sent malformed.
 *
 * Callable wherever a stream is first declared (a host can run it at wiring to fail before any send).
 * `drip/transactional.ts` also re-checks at call time; this is the early surfacing of the same rule.
 *
 * @throws {ValidationError} on a missing / non-string / unknown stream.
 */
export function assertTransactionalStream(
  stream: unknown,
  context?: string
): asserts stream is Stream {
  const where = context ? `${context}: ` : "";
  if (typeof stream !== "string" || stream.trim().length === 0) {
    throw new ValidationError(
      `${where}a transactional send must name a \`stream\` — it scopes the List-Unsubscribe ` +
        `token (R33/R46); a send with no stream is rejected at config time, never sent with a ` +
        `malformed or omitted unsubscribe (R45).`
    );
  }
  if (!STREAMS.includes(stream as Stream)) {
    throw new ValidationError(
      `${where}unknown stream "${stream}" — expected one of ${STREAMS.map((s) => `'${s}'`).join(
        ", "
      )} (R45/R46).`
    );
  }
}

/**
 * The host's declaration of the ordering column that backs a broadcast program's monotonic cursor.
 * The SDK cannot read the host's content tables (R38/R45), so the host DECLARES the column it
 * advances the watermark over, and the SDK validates the declaration is sound at setup.
 */
export interface WatermarkColumnDeclaration {
  /** The host column name backing the watermark (e.g. `created_at`, `id`). Informational + surfaced
   *  in error messages; must be non-empty. */
  column: string;
  /** The column's scalar type — a timestamp/id ordering column. Both sort monotonically (timestamps
   *  lexicographically as ISO-8601, ids numerically) — matching `cursor.advance`'s compare. */
  type: "timestamptz" | "timestamp" | "bigint" | "integer" | "text" | "uuid";
  /** Whether the host column is NULLABLE. MUST be `false`: a nullable ordering column cannot back a
   *  strictly-greater watermark (a null row has no position), so a `true` here is rejected at setup
   *  rather than surfacing as a `cursor.advance` throw on the first real send (R36/R45). */
  nullable: boolean;
}

/**
 * Assert a broadcast program's declared watermark column is non-nullable (R45). A nullable ordering
 * column cannot back the monotonic cursor: `cursor.advance` rejects a null watermark at runtime, but
 * that is the LAST-line defense (it would fail at the first send). This is the EARLY surfacing — a
 * host that declares `nullable: true` at `defineBroadcastProgram` setup fails immediately, before any
 * cron is wired.
 *
 * @throws {ValidationError} on a `nullable: true` declaration, an empty column, or an unknown type.
 */
export function assertWatermarkColumnType(
  decl: WatermarkColumnDeclaration,
  context?: string
): void {
  const where = context ? `${context}: ` : "";
  if (decl === null || typeof decl !== "object") {
    throw new ValidationError(
      `${where}watermark column declaration must be a { column, type, nullable } object (R45).`
    );
  }
  if (typeof decl.column !== "string" || decl.column.trim().length === 0) {
    throw new ValidationError(`${where}watermark column declaration requires a non-empty \`column\` name.`);
  }
  const VALID_TYPES = ["timestamptz", "timestamp", "bigint", "integer", "text", "uuid"] as const;
  if (!VALID_TYPES.includes(decl.type as (typeof VALID_TYPES)[number])) {
    throw new ValidationError(
      `${where}watermark column "${decl.column}" has an unknown type "${String(decl.type)}" — ` +
        `expected one of ${VALID_TYPES.map((t) => `'${t}'`).join(", ")} (a monotonic ordering column).`
    );
  }
  if (decl.nullable !== false) {
    throw new ValidationError(
      `${where}watermark column "${decl.column}" is declared NULLABLE — a nullable ordering column ` +
        `cannot back a monotonic broadcast cursor (a null row has no position). Make the column ` +
        `NOT NULL, or pick a non-nullable ordering column (R36/R45).`
    );
  }
}

// =================================================================================================
// 2. Lazy, network: slot ⇄ Template check
// =================================================================================================

/**
 * The outcome of validating ONE sequence step's `aiSlots` against its Template. Exactly one of
 * `ok` / `warned` / `missing` is the dominant state per step:
 *   - `ok: true`        — every declared slot exists on the Template's concrete variable list.
 *   - `warned`          — the Template returned `variables: null` (a draft / variable-less Template):
 *                         we CANNOT CONFIRM the slots, so this is a warning, not a failure.
 *   - `missing` (≥ 1)   — the Template has a concrete variable list and one or more declared slots are
 *                         absent from it: a hard error (collected, then thrown together).
 */
export interface StepSlotCheck {
  stepIndex: number;
  templateId: string;
  /** Declared slots that do NOT exist on the Template's concrete variable list. */
  missing: readonly string[];
  /** True when the Template's variables came back `null` (cannot confirm — a warning). */
  warned: boolean;
}

/** The full result of {@link validateSequenceSlots} — a per-step breakdown plus rolled-up warnings. */
export interface SequenceValidationResult {
  sequenceKey: string;
  steps: readonly StepSlotCheck[];
  /** Human-readable warnings (one per draft/variable-less Template a slot could not be confirmed
   *  against). Surfaced to the host (R39) — never swallowed, never fatal. */
  warnings: readonly string[];
}

// Structural view of `client.templates.get` — the RAW shape, where `variables` may be `null`. We use
// the raw client (not `getTemplate`) on purpose: `getTemplate` normalizes `variables: null` → `[]`,
// which erases the draft-vs-empty distinction R45 hinges on (null ⇒ warn; empty ⇒ a declared slot is
// genuinely absent ⇒ error). Mirrors the `TemplatesGetClient` idiom in `resend/templates.ts`.
interface RawTemplatesGetClient {
  templates: {
    get(id: string): Promise<{
      data:
        | {
            id: string;
            html: string;
            text: string | null;
            variables: { key: string }[] | null;
          }
        | null;
      error: { message?: string } | null;
    }>;
  };
}

/**
 * A raw fetch of a Template's variable keys, PRESERVING the `null` signal. Returns:
 *   - `{ keys: string[] }`  — the Template has a concrete variable list (possibly empty).
 *   - `{ keys: null }`      — the Template returned `variables: null` (draft / variable-less).
 *
 * Cached per Template id (a multi-step sequence referencing the same Template fetches once; the cache
 * is also the "fired on first use" memo). Pass `{ refresh: true }` to force a re-fetch.
 *
 * @throws {ValidationError} when Resend is unset (the check cannot run with no key — but it is only
 *   ever called lazily, so an unset-key install that never calls `validate()` stays a no-op) or when
 *   `templates.get` errors / the Template is not found.
 */
const rawVariableCache = new Map<string, readonly string[] | null>();

/** Drop the slot-check cache (tests; or a host that knows a Template was edited upstream). */
export function clearValidationCache(): void {
  rawVariableCache.clear();
}

async function fetchTemplateVariableKeys(
  resend: ResendClientHandle,
  templateId: string,
  opts?: { refresh?: boolean }
): Promise<readonly string[] | null> {
  if (typeof templateId !== "string" || templateId.trim().length === 0) {
    throw new ValidationError("a sequence step references an empty templateId — cannot validate slots.");
  }

  if (!opts?.refresh && rawVariableCache.has(templateId)) {
    return rawVariableCache.get(templateId) ?? null;
  }

  const client = resend.client() as unknown as RawTemplatesGetClient | null;
  if (!resend.enabled || client === null) {
    throw new ValidationError(
      `cannot validate template "${templateId}": Resend is not configured (set RESEND_API_KEY). ` +
        `The slot⇄Template check is network-bound; run \`envoy.validate()\` only where Resend is reachable.`
    );
  }

  const { data, error } = await client.templates.get(templateId);
  if (error || !data) {
    throw new ValidationError(
      `Resend templates.get failed for "${templateId}": ${error?.message ?? "template not found"}. ` +
        `A sequence step cannot reference a Template that does not exist (R45).`
    );
  }

  // PRESERVE the null signal: a null variables array means "draft / cannot confirm", a concrete
  // (even empty) array means "this is the Template's full variable set".
  const keys =
    data.variables === null || data.variables === undefined
      ? null
      : Object.freeze(
          data.variables
            .filter((v): v is { key: string } => v !== null && typeof v === "object" && typeof v.key === "string")
            .map((v) => v.key)
        );

  rawVariableCache.set(templateId, keys);
  return keys;
}

/**
 * Validate ONE sequence's declared `aiSlots` against its steps' Resend Templates (the lazy, network
 * arm of R45). Fetches each step's Template (cached, deduped), then for each step:
 *   - concrete variable list present  → every declared slot must exist on it, else `missing`.
 *   - `variables: null` (draft)       → cannot confirm → `warned: true`, surfaced as a warning.
 *
 * Collects ALL missing slots across ALL steps and throws ONE `ValidationError` listing every offender
 * (so a host fixes them in a single pass, not one error per redeploy). When nothing is missing it
 * returns the per-step breakdown plus any warnings (never throws on a warning).
 *
 * @throws {ValidationError} when one or more declared slots are absent from a concrete Template list,
 *   or when a Template cannot be fetched (Resend unset / not found / upstream error).
 */
export async function validateSequenceSlots(
  resend: ResendClientHandle,
  sequence: Sequence,
  opts?: { refresh?: boolean }
): Promise<SequenceValidationResult> {
  if (sequence === null || typeof sequence !== "object" || !Array.isArray(sequence.steps)) {
    throw new ValidationError("validateSequenceSlots requires a defined Sequence.");
  }

  const steps: StepSlotCheck[] = [];
  const warnings: string[] = [];

  for (let i = 0; i < sequence.steps.length; i++) {
    const step = sequence.steps[i]!;
    const declared: readonly string[] = step.aiSlots ?? [];

    // A step with no declared slots has nothing to validate against the Template (a fully-static
    // Template). Skip the fetch entirely — no need to reach Resend for a step that declares nothing.
    if (declared.length === 0) {
      steps.push(Object.freeze({ stepIndex: i, templateId: step.templateId, missing: Object.freeze([]), warned: false }));
      continue;
    }

    const keys = await fetchTemplateVariableKeys(resend, step.templateId, opts);

    if (keys === null) {
      // Draft / variable-less Template — cannot confirm. Warn, do not fail.
      warnings.push(
        `sequence "${sequence.key}" step ${i}: Template "${step.templateId}" returned no variable list ` +
          `(draft or variable-less) — cannot confirm slots [${declared.join(", ")}]. Publish the Template ` +
          `or re-run validation once it declares its variables (R45).`
      );
      steps.push(Object.freeze({ stepIndex: i, templateId: step.templateId, missing: Object.freeze([]), warned: true }));
      continue;
    }

    const present = new Set(keys);
    const missing = declared.filter((slot) => !present.has(slot));
    steps.push(
      Object.freeze({
        stepIndex: i,
        templateId: step.templateId,
        missing: Object.freeze([...missing]),
        warned: false,
      })
    );
  }

  const offenders = steps.filter((s) => s.missing.length > 0);
  if (offenders.length > 0) {
    const detail = offenders
      .map(
        (s) =>
          `step ${s.stepIndex} (Template "${s.templateId}"): missing slot(s) [${s.missing.join(", ")}]`
      )
      .join("; ");
    throw new ValidationError(
      `sequence "${sequence.key}" declares AI slots that do not exist on their Resend Templates — ${detail}. ` +
        `Every \`aiSlots\` entry must be a declared variable on its Template, or the AI has nowhere to ` +
        `write at send time (R45).`
    );
  }

  return Object.freeze({
    sequenceKey: sequence.key,
    steps: Object.freeze(steps),
    warnings: Object.freeze(warnings),
  });
}

/**
 * Validate MANY sequences in one pass (the shape `envoy.validate()` drives). Runs each sequence's
 * slot check (sharing the per-Template cache so a Template referenced by two sequences is fetched
 * once), accumulates warnings, and throws on the FIRST sequence that has missing slots (its
 * `ValidationError` already lists every offender within that sequence).
 *
 * Returns the aggregate result (all per-sequence breakdowns + all warnings) when every sequence is OK
 * or only warns. This is the function a host calls explicitly at deploy time; it is also what the
 * drip engine can call lazily on a sequence's first tick (cached, so subsequent ticks are free).
 */
export async function validateSequences(
  resend: ResendClientHandle,
  sequences: readonly Sequence[],
  opts?: { refresh?: boolean }
): Promise<{ sequences: readonly SequenceValidationResult[]; warnings: readonly string[] }> {
  const results: SequenceValidationResult[] = [];
  const warnings: string[] = [];
  for (const sequence of sequences) {
    const res = await validateSequenceSlots(resend, sequence, opts);
    results.push(res);
    warnings.push(...res.warnings);
  }
  return Object.freeze({ sequences: Object.freeze(results), warnings: Object.freeze(warnings) });
}

/** Inputs to {@link validateConfig} / `envoy.validate()`. */
export interface ValidateInput {
  /** Sequences whose declared `aiSlots` are checked against their Templates (the network arm). */
  sequences?: readonly Sequence[];
  /** Per-program watermark column declarations checked for non-nullability (the sync arm). */
  watermarks?: readonly WatermarkColumnDeclaration[];
  /** Force a re-fetch of every Template (ignore the slot-check cache). */
  refresh?: boolean;
}

/** The aggregate result of a full {@link validateConfig} pass. */
export interface ValidateResult {
  sequences: readonly SequenceValidationResult[];
  /** All accumulated warnings (draft Templates that could not be confirmed) — surfaced, not fatal. */
  warnings: readonly string[];
}

/**
 * The full config-time validation entry point — the function `envoy.validate()` wraps (U18 / R45).
 * Runs, in order:
 *   1. the SYNCHRONOUS watermark-column checks (no network — fails loud on a nullable declaration), then
 *   2. the LAZY slot⇄Template network checks for every passed sequence (fails loud on a missing slot).
 *
 * Synchronous checks run FIRST so a nullable-column or bad-type mistake fails without spending a
 * Resend round-trip. Never runs at module load — the host calls it explicitly (or the engine calls it
 * lazily on first tick), preserving U3's unset-key no-op for installs that never validate.
 *
 * @throws {ValidationError} on the first hard failure (nullable watermark, unknown stream/type, or a
 *   missing slot). Warnings (draft Templates) are returned, never thrown.
 */
export async function validateConfig(
  envoy: Envoy,
  input: ValidateInput
): Promise<ValidateResult> {
  if (input === null || typeof input !== "object") {
    throw new ValidationError("validate() requires an input object ({ sequences?, watermarks? }).");
  }

  // 1. Synchronous, no-network — watermark column declarations.
  for (const decl of input.watermarks ?? []) {
    assertWatermarkColumnType(decl);
  }

  // 2. Lazy, network — slot ⇄ Template.
  const opts = input.refresh ? { refresh: true } : undefined;
  const { sequences, warnings } = await validateSequences(envoy.resend, input.sequences ?? [], opts);

  return Object.freeze({ sequences, warnings });
}
