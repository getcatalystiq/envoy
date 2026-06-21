import "server-only";

// Broadcast cursor primitive — watermark + issue sequence per (programKey, subjectKey)
// (U13 / origin R36, R45).
//
// The broadcast lane is host-clocked: the host wires its own cron (separate from the drip cron),
// owns the content query (what is new) and the eligibility predicate (who), and Envoy owns the
// mechanics. The cursor is one of those mechanics. It tracks, per program+subject, a high-water
// mark over the host's chosen ordering column (a created_at, a monotonically increasing id —
// whatever the host declares) plus a monotonic issue sequence and a health timestamp.
//
// Three operations (R36):
//   - read(key)              → { watermark, issueSeq, lastFiredAt, paused }. The lazy-default for a
//                              never-seen key is { watermark: null, issueSeq: 0, lastFiredAt: null,
//                              paused: false } — no row is written on a pure read.
//   - due(cur, { cadenceDays }) → boolean N-day timer. Never fired (lastFiredAt null) ⇒ due.
//                              Paused ⇒ never due. Otherwise due once cadenceDays have elapsed
//                              since lastFiredAt.
//   - advance(key, { watermark, issueSeq, itemIds }) → moves the watermark ONLY on a real send,
//                              with a STRICTLY-GREATER (`>`) compare so a same-instant item is never
//                              re-sent, and a NULL/non-monotonic watermark is rejected at runtime
//                              (R45: the SDK cannot read the host's content tables, so the nullable-
//                              column mistake is caught here rather than silently advancing).
//
// `read` exposes `lastFiredAt` as a HEALTH signal: a host-driven clock has no Envoy daemon to
// notice if the host's cron stops, so the host alerts on a stale lastFiredAt itself.
//
// Patterns reimplemented (never imported, per R48): the `newsletter_country_state`-style per-key
// clock (origin) and the monotonic-advance discipline. This module touches `sdk_program_state`
// (see migrations/001_core.sql: UNIQUE (namespace, program_key, subject_key); watermark TEXT NULL;
// issue_seq BIGINT DEFAULT 0; last_fired_at TIMESTAMPTZ; paused BOOLEAN DEFAULT FALSE).
//
// Watermark comparison: the host owns the ordering column's semantics, but the cursor must compare
// values without re-reading the host's content. Watermarks are stored as TEXT. We compare
// numerically when BOTH the current and incoming values parse as finite numbers (ids, epoch ms),
// otherwise lexicographically (ISO-8601 timestamps sort correctly as strings). Either way the
// guard is strictly-greater: equal is rejected (same-instant re-send), lesser is rejected
// (non-monotonic / clock skew / replay).

import type { NamespacedDb } from "../db/pool.js";

/** Table backing the per-key broadcast clock (see migrations/001_core.sql). */
const STATE_TABLE = "sdk_program_state";

/**
 * The cursor identity: a program (a `defineBroadcastProgram` key) and a subject (the unit the
 * watermark advances over — often a single global "default" subject for a simple newsletter, or a
 * per-locale / per-segment subject for a fan-out program). Both are bare host keys; the db wrapper
 * namespaces them so two installs on one Postgres never collide (R38).
 */
export interface CursorKey {
  /** Host program key (bare; namespaced by the db wrapper on write/read). */
  programKey: string;
  /** Host subject key (bare; the watermark advances per subject). */
  subjectKey: string;
}

/** The cursor state as surfaced to the host. */
export interface CursorState {
  /** The high-water mark over the host's ordering column, or null when the program has never sent
   *  for this subject (a never-seen key reads as null without writing a row). */
  watermark: string | null;
  /** Monotonic issue sequence — how many issues have been sent for this (program, subject). 0 for a
   *  never-seen key. The host may use it to label issues; `advance` records the host-supplied next
   *  value (it does not auto-increment, so the host stays the source of truth). */
  issueSeq: number;
  /** When the cursor last advanced (a real send). Null for a never-seen key. Exposed as a HEALTH
   *  signal: a stale lastFiredAt means the host's cron may have stopped (R36). */
  lastFiredAt: string | null;
  /** Whether the host has paused this (program, subject). A paused cursor is never `due`. */
  paused: boolean;
}

function stateFromDb(r: {
  watermark: string | null;
  issue_seq: number | string | null;
  last_fired_at: string | null;
  paused: boolean;
}): CursorState {
  // BIGINT comes back as a string from node-postgres; normalize to a JS number. (Issue sequences
  // are small; the BIGINT column is room to grow, not a precision requirement.)
  const seq =
    typeof r.issue_seq === "string"
      ? Number.parseInt(r.issue_seq, 10)
      : r.issue_seq ?? 0;
  return {
    watermark: r.watermark,
    issueSeq: Number.isFinite(seq) ? seq : 0,
    lastFiredAt: r.last_fired_at,
    paused: r.paused === true,
  };
}

/** The default state for a never-seen (program, subject): no watermark, seq 0, never fired, live. */
const DEFAULT_STATE: CursorState = {
  watermark: null,
  issueSeq: 0,
  lastFiredAt: null,
  paused: false,
};

function assertNonEmpty(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`[@envoy/sdk] ${name} must be a non-empty string.`);
  }
}

/**
 * Read the cursor state for `key`. A never-seen key reads as the lazy default
 * (`{ watermark: null, issueSeq: 0, lastFiredAt: null, paused: false }`) WITHOUT writing a row — a
 * pure read has no side effects, so the cursor row is materialized only on the first `advance`.
 */
export async function read(db: NamespacedDb, key: CursorKey): Promise<CursorState> {
  assertNonEmpty("programKey", key.programKey);
  assertNonEmpty("subjectKey", key.subjectKey);
  const program = db.namespaceKey(key.programKey);
  const subject = db.namespaceKey(key.subjectKey);

  const res = await db.query<{
    watermark: string | null;
    issue_seq: number | string | null;
    last_fired_at: string | null;
    paused: boolean;
  }>(
    `SELECT watermark, issue_seq, last_fired_at, paused
       FROM ${STATE_TABLE}
      WHERE namespace = $1 AND program_key = $2 AND subject_key = $3`,
    [db.namespace, program, subject]
  );

  const found = res.rows[0];
  return found ? stateFromDb(found) : { ...DEFAULT_STATE };
}

/** Options for {@link due}. */
export interface DueOptions {
  /** The cadence window in days — `due` is true once this many days have elapsed since the last
   *  send. Must be a finite, positive number. */
  cadenceDays: number;
  /** Injectable clock (tests pass a fixed instant). Defaults to `Date.now()`. */
  now?: () => number;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The N-day timer. Returns whether a send is DUE for the given cursor state and cadence:
 *   - paused                     → false (a paused cursor never fires)
 *   - never fired (lastFiredAt null) → true (the first issue is always due)
 *   - lastFiredAt unparseable    → true (fail toward firing rather than silently stalling; a bad
 *                                  stored timestamp should surface as a send, not an indefinite gap)
 *   - otherwise                  → (now - lastFiredAt) >= cadenceDays
 *
 * `due` is a pure predicate over the passed state — it never reads the db. The caller pairs it with
 * {@link read}.
 *
 * @throws on a non-finite or non-positive `cadenceDays` (a zero/negative cadence is a config bug:
 *   it would fire every tick — fail loud rather than blast).
 */
export function due(state: CursorState, opts: DueOptions): boolean {
  const { cadenceDays } = opts;
  if (typeof cadenceDays !== "number" || !Number.isFinite(cadenceDays) || cadenceDays <= 0) {
    throw new Error(
      `[@envoy/sdk] cadenceDays must be a finite positive number (got ${String(cadenceDays)}).`
    );
  }
  if (state.paused) return false;
  if (state.lastFiredAt === null) return true;

  const last = Date.parse(state.lastFiredAt);
  if (!Number.isFinite(last)) return true; // unparseable stored timestamp ⇒ fire (don't stall).

  const now = (opts.now ?? Date.now)();
  return now - last >= cadenceDays * MS_PER_DAY;
}

/**
 * Compare two watermark strings under the strictly-greater discipline. Returns true iff
 * `incoming > current`. Numeric when BOTH parse as finite numbers (ids, epoch ms); lexicographic
 * otherwise (ISO-8601 sorts correctly as text). A `current` of null is always exceeded by any
 * (already-validated non-null) incoming value (the very first advance).
 */
function isStrictlyGreater(incoming: string, current: string | null): boolean {
  if (current === null) return true;
  const a = Number(incoming);
  const b = Number(current);
  // Number("") === 0 and Number("  ") === 0 — guard against empty/whitespace masquerading as 0.
  const incomingNumeric = incoming.trim() !== "" && Number.isFinite(a);
  const currentNumeric = current.trim() !== "" && Number.isFinite(b);
  if (incomingNumeric && currentNumeric) {
    return a > b;
  }
  return incoming > current;
}

/** Options for {@link advance}. */
export interface AdvanceOptions {
  /** The new high-water mark — the ordering-column value of the newest item included in THIS send.
   *  Must be a non-null, non-empty string that is strictly greater than the stored watermark. A
   *  null/empty value is rejected (R45: the host's nullable ordering-column mistake surfaces here). */
  watermark: string;
  /** The issue sequence this send represents (host-supplied; the host owns issue numbering). When
   *  omitted, the stored `issue_seq` is incremented by 1. */
  issueSeq?: number;
  /** Provenance: the host content item ids included in this issue. Stored on the row for audit; not
   *  part of the watermark compare. (Reserved for parity with the claim row; currently advisory.) */
  itemIds?: ReadonlyArray<string>;
  /** Injectable clock for `last_fired_at` in tests. Defaults to DB `NOW()` when omitted. */
  firedAt?: string;
}

/** Outcome of {@link advance}. */
export interface AdvanceResult {
  /** True iff the watermark actually moved (the strictly-greater compare passed and the row was
   *  written). False only via {@link tryAdvance} when the incoming watermark was not greater (a
   *  skip-zero / only-if-new tick). `advance` itself throws on a non-monotonic watermark rather than
   *  returning `advanced: false`. */
  advanced: boolean;
  /** The cursor state after the operation (the new state on an advance; the unchanged stored state
   *  on a no-op skip). */
  state: CursorState;
}

/**
 * Advance the cursor for `key` — called ONLY on a real send (R36). Writes the new watermark, issue
 * sequence, and `last_fired_at` iff the incoming watermark is STRICTLY GREATER than the stored one.
 *
 * Rejects (throws), never silently advancing:
 *   - a null / non-string / empty `watermark` (R45 — the nullable ordering-column mistake), and
 *   - a non-monotonic `watermark` (<= the stored value: a same-instant duplicate or clock skew /
 *     replay that would re-send already-sent content).
 *
 * The write is a single upsert (`INSERT … ON CONFLICT … DO UPDATE`) guarded in its `WHERE` by the
 * strictly-greater compare, so two concurrent ticks racing the same key cannot both advance — the
 * loser's UPDATE matches no row and it re-reads the (advanced) state. Materializes the row on first
 * advance.
 *
 * For the skip-zero / only-if-new path (no new content ⇒ DO NOT advance), use {@link tryAdvance},
 * which returns `{ advanced: false }` instead of throwing.
 */
export async function advance(
  db: NamespacedDb,
  key: CursorKey,
  opts: AdvanceOptions
): Promise<CursorState> {
  const res = await tryAdvance(db, key, opts, { rejectNonMonotonic: true });
  return res.state;
}

/**
 * The skip-tolerant sibling of {@link advance}. Identical watermark validation (a null/empty
 * watermark still throws — that is a config bug, not a skip), but a NON-MONOTONIC watermark returns
 * `{ advanced: false, state: <unchanged stored state> }` instead of throwing. Use this on the
 * only-if-new / skip-zero path where "nothing newer to send" is an expected no-op, not an error.
 */
export async function tryAdvance(
  db: NamespacedDb,
  key: CursorKey,
  opts: AdvanceOptions,
  cfg?: { rejectNonMonotonic?: boolean }
): Promise<AdvanceResult> {
  assertNonEmpty("programKey", key.programKey);
  assertNonEmpty("subjectKey", key.subjectKey);
  const rejectNonMonotonic = cfg?.rejectNonMonotonic ?? false;

  // R45: a null/empty watermark is a host-contract mistake (a nullable ordering column), not a skip.
  // Always fail loud, in BOTH advance and tryAdvance.
  if (typeof opts.watermark !== "string" || opts.watermark.length === 0) {
    throw new Error(
      `[@envoy/sdk] cursor.advance: watermark must be a non-null, non-empty string ` +
        `(got ${opts.watermark === null ? "null" : `"${String(opts.watermark)}"`}). A nullable ` +
        `ordering column cannot back a monotonic cursor (R36/R45).`
    );
  }

  const program = db.namespaceKey(key.programKey);
  const subject = db.namespaceKey(key.subjectKey);

  // Read the current state to make the monotonic decision in JS (the strictly-greater guard is also
  // enforced in the UPDATE WHERE, so a concurrent racer cannot slip a lesser value through).
  const current = await read(db, key);

  if (!isStrictlyGreater(opts.watermark, current.watermark)) {
    if (rejectNonMonotonic) {
      throw new Error(
        `[@envoy/sdk] cursor.advance: watermark "${opts.watermark}" is not strictly greater than ` +
          `the stored watermark "${String(current.watermark)}" — refusing to advance (a same-instant ` +
          `or older value would re-send already-sent content; R36 strictly-greater guard).`
      );
    }
    // Skip path: nothing newer to send. Do not write; surface the unchanged state.
    return { advanced: false, state: current };
  }

  const nextSeq = opts.issueSeq ?? current.issueSeq + 1;
  if (typeof nextSeq !== "number" || !Number.isFinite(nextSeq) || nextSeq < 0) {
    throw new Error(
      `[@envoy/sdk] cursor.advance: issueSeq must be a non-negative finite number (got ${String(nextSeq)}).`
    );
  }
  const itemIds = opts.itemIds ? Array.from(opts.itemIds) : [];

  // Upsert. The `WHERE` on the DO UPDATE re-applies the strictly-greater guard at the storage layer:
  // a numeric compare when both parse as numbers, else a text compare — mirroring isStrictlyGreater.
  // The `firedAt` override (tests) lands as a literal; otherwise NOW().
  const firedAtSql = opts.firedAt !== undefined ? "$6::timestamptz" : "NOW()";
  const params: unknown[] = [db.namespace, program, subject, opts.watermark, nextSeq];
  if (opts.firedAt !== undefined) params.push(opts.firedAt);

  const updated = await db.execWrite<{
    watermark: string | null;
    issue_seq: number | string | null;
    last_fired_at: string | null;
    paused: boolean;
  }>(
    `INSERT INTO ${STATE_TABLE}
        (namespace, program_key, subject_key, watermark, issue_seq, last_fired_at)
     VALUES ($1, $2, $3, $4, $5, ${firedAtSql})
     ON CONFLICT (namespace, program_key, subject_key) DO UPDATE
        SET watermark     = EXCLUDED.watermark,
            issue_seq     = EXCLUDED.issue_seq,
            last_fired_at = EXCLUDED.last_fired_at,
            updated_at    = NOW()
      WHERE ${STATE_TABLE}.watermark IS NULL
         OR (
              ${STATE_TABLE}.watermark ~ '^[0-9.eE+-]+$'
              AND EXCLUDED.watermark ~ '^[0-9.eE+-]+$'
              AND EXCLUDED.watermark::double precision > ${STATE_TABLE}.watermark::double precision
            )
         OR (
              NOT (${STATE_TABLE}.watermark ~ '^[0-9.eE+-]+$' AND EXCLUDED.watermark ~ '^[0-9.eE+-]+$')
              AND EXCLUDED.watermark > ${STATE_TABLE}.watermark
            )
      RETURNING watermark, issue_seq, last_fired_at, paused`,
    params
  );

  if (updated.count > 0) {
    void itemIds; // provenance is advisory at this layer; reserved for a future audit column.
    return { advanced: true, state: stateFromDb(updated.rows[0]!) };
  }

  // The INSERT hit the conflict and the storage-level guard rejected the UPDATE — a concurrent racer
  // advanced past us between our read and our write. Re-read and surface the (advanced) state. Our
  // JS guard already passed, so reaching here means a true race; the watermark did NOT move for US.
  const after = await read(db, key);
  return { advanced: false, state: after };
}

/**
 * Set the paused flag for `key` (a host kill-switch independent of the watermark). Materializes the
 * row if absent. A paused cursor is never {@link due}. Returns the post-update state.
 */
export async function setPaused(
  db: NamespacedDb,
  key: CursorKey,
  paused: boolean
): Promise<CursorState> {
  assertNonEmpty("programKey", key.programKey);
  assertNonEmpty("subjectKey", key.subjectKey);
  const program = db.namespaceKey(key.programKey);
  const subject = db.namespaceKey(key.subjectKey);

  const res = await db.execWrite<{
    watermark: string | null;
    issue_seq: number | string | null;
    last_fired_at: string | null;
    paused: boolean;
  }>(
    `INSERT INTO ${STATE_TABLE} (namespace, program_key, subject_key, paused)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (namespace, program_key, subject_key) DO UPDATE
        SET paused = EXCLUDED.paused, updated_at = NOW()
      RETURNING watermark, issue_seq, last_fired_at, paused`,
    [db.namespace, program, subject, paused]
  );
  return stateFromDb(res.rows[0]!);
}
