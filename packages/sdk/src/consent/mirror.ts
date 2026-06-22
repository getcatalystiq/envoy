import "server-only";

// Consent mirror — the gate every send consults (U6 / origin R26, R28, KTD9).
//
// Resend's hosted Topic preferences are the source of truth for what a recipient has agreed to
// receive, but a per-send Resend round-trip on every email is neither cheap nor reliable. So the
// SDK keeps a LOCAL mirror of per-`(contact, topic)` consent and treats it as authoritative at
// send time (R26). The mirror is kept in sync with Resend by:
//   - `consent.set` (this file): the host/in-app toggle path — writes the mirror first, then awaits
//     the `contacts.topics.update` push so an unsubscribe is confirmed in Resend before the caller
//     proceeds (origin R28: "unsubscribe push is awaited/confirmed").
//   - the reconcile sweep (U14): catches topic opt-outs made on Resend's hosted page, which carry
//     no `topic_id` in the webhook and are therefore invisible to the webhook receiver (R29).
//
// Two invariants enforced here:
//   1. MONOTONIC MERGE — `unsubscribed` dominates. Once a stream (or the whole contact) is
//      `unsubscribed`, a later stale `opt_in` write must NOT silently re-subscribe them. This is
//      the suppress-at-every-site / monotonic-merge pattern from the CRM lifecycle CAS-gate
//      learning: a consent write only ever moves toward MORE suppression, never less, unless the
//      caller is an explicit re-subscribe (which the host must route as its own opt_in AFTER the
//      recipient asked — there is no path here that resurrects an unsubscribed contact implicitly).
//   2. DUAL STREAM — each topic carries TWO independent consent columns, one per stream
//      (`digest`, `alert`). A digest opt-out leaves alerts flowing and vice-versa; only a global
//      `unsubscribed` (the recipient's "everything" choice) stops both.

import { normalizeEmail, type NamespacedDb } from "../db/pool.js";
import type { ResendClientHandle } from "../resend/client.js";

/**
 * The two delivery streams a topic can carry. A "stream" is a type-of-email lane: `digest` is the
 * recurring/marketing cadence, `alert` is event-triggered. They share a topic row but have
 * independent consent so opting out of one never silences the other (R27/R33).
 */
export type Stream = "digest" | "alert";

/** All streams, in a stable order. Used when an `unsubscribed` write must touch every stream. */
export const STREAMS: readonly Stream[] = Object.freeze(["digest", "alert"]);

/**
 * Per-stream consent state, mirroring Resend's `'opt_in' | 'opt_out'` subscription plus the SDK's
 * own terminal `'unsubscribed'`.
 *
 * - `opt_in` — receiving this stream of this topic (the default; topics are created public + opt_in).
 * - `opt_out` — topic-scoped opt-out for this stream; the recipient still receives OTHER topics.
 * - `unsubscribed` — terminal: the recipient asked to stop everything. Dominates all streams of
 *   this topic and is mirrored into the contact's global `unsubscribed` flag (R26 suppress-all).
 */
export type ConsentStatus = "opt_in" | "opt_out" | "unsubscribed";

/**
 * Suppression rank for the monotonic merge. A write only lands if its rank is `>=` the stored
 * rank — i.e. consent moves toward MORE suppression, never less. `unsubscribed` (rank 2) dominates
 * `opt_out` (1) dominates `opt_in` (0). A re-subscribe (lowering the rank) is intentionally NOT a
 * thing this path does; it is a no-op against a more-suppressed stored value.
 */
const RANK: Record<ConsentStatus, number> = { opt_in: 0, opt_out: 1, unsubscribed: 2 };

/** Resend's two-valued subscription. `unsubscribed` maps to `opt_out` when pushed per-topic; the
 * "everything" choice is additionally reflected by the global suppression flag. */
type ResendSubscription = "opt_in" | "opt_out";

function toResendSubscription(status: ConsentStatus): ResendSubscription {
  return status === "opt_in" ? "opt_in" : "opt_out";
}

/**
 * A row of the consent mirror for one `(contact, topic)`. `digest`/`alert` are the per-stream
 * states; `topicId` is the cached Resend Topic id (null until provisioned, U7); `dirty` is true
 * when the mirror and Resend may have diverged and the reconcile sweep should repair this row.
 */
export interface ConsentRow {
  contact: string;
  topicKey: string;
  topicId: string | null;
  digest: ConsentStatus;
  alert: ConsentStatus;
  dirty: boolean;
}

/** Raw DB shape of a `sdk_topic_consent` row (snake_case columns). */
interface RawConsentRow {
  contact: string;
  topic_key: string;
  topic_id: string | null;
  digest_status: ConsentStatus;
  alert_status: ConsentStatus;
  dirty_since: string | null;
}

function mapRow(r: RawConsentRow): ConsentRow {
  return {
    contact: r.contact,
    topicKey: r.topic_key,
    topicId: r.topic_id,
    digest: r.digest_status,
    alert: r.alert_status,
    dirty: r.dirty_since !== null,
  };
}

/** Arguments to `consent.set` — the single write path into the mirror (origin R26/R28). */
export interface ConsentSetInput {
  /** Recipient email (the logical contact key; namespace-prefixed at the DB boundary). */
  email: string;
  /** The topic this consent applies to (host-meaningful key, e.g. `weekly-digest`). */
  topicKey: string;
  /** Which stream of the topic to set. */
  stream: Stream;
  /** Target consent. `unsubscribed` dominates BOTH streams + the global flag (R26). */
  status: ConsentStatus;
  /**
   * Cached Resend Topic id, if known by the caller (U7 provisioning). When provided it is stored
   * so the push + reconcile can address the topic; when omitted the push is skipped (no topic id =
   * nothing to push) and the row is marked dirty for the reconcile sweep to resolve.
   */
  topicId?: string | null;
}

/** Outcome of a `consent.set` — whether the mirror changed and whether the Resend push confirmed. */
export interface ConsentSetResult {
  /** The resulting mirror row (post-merge). */
  row: ConsentRow;
  /** True when the write actually changed stored state (false = a stale/no-op merge). */
  changed: boolean;
  /**
   * `confirmed` — the Resend `contacts.topics.update` push succeeded and the row is clean.
   * `skipped` — no Resend (key unset) or no topic id; nothing pushed, row left clean (digest path)
   *   or dirty (no topic id, needs reconcile).
   * `dirty` — the push was attempted and FAILED; the row is marked reconcile-dirty (R28: never
   *   throw into the caller on a push failure; mark dirty and let reconcile repair).
   */
  push: "confirmed" | "skipped" | "dirty";
}

/**
 * The consent mirror, bound to one install's namespaced DB + Resend handle. Build via `createConsentMirror`.
 */
export class ConsentMirror {
  constructor(
    private readonly db: NamespacedDb,
    private readonly resend: ResendClientHandle
  ) {}

  /**
   * Read the mirror row for `(email, topicKey)`, or `null` if the contact has never been seen for
   * this topic. This is a pure read — it does NOT create a default row (a missing row means the
   * topic was never provisioned for this contact; the gate treats that as deny-by-default).
   */
  async read(email: string, topicKey: string): Promise<ConsentRow | null> {
    const contact = this.db.namespaceKey(normalizeEmail(email));
    const res = await this.db.query<RawConsentRow>(
      `SELECT contact, topic_key, topic_id, digest_status, alert_status, dirty_since
         FROM sdk_topic_consent
        WHERE namespace = $1 AND contact = $2 AND topic_key = $3`,
      [this.db.namespace, contact, topicKey]
    );
    const raw = res.rows[0];
    return raw ? mapRow(raw) : null;
  }

  /**
   * Read the contact-level GLOBAL suppression flag (`sdk_contacts.unsubscribed`), case-insensitively
   * on the bare email (matches the webhook/`set` convention). A bounce, complaint, GDPR delete, or
   * hosted-page unsubscribe sets this flag; the gate must honor it on EVERY topic/stream — including
   * topics for which no per-topic consent row exists — so a globally-suppressed contact can never be
   * re-addressed on any lane (R22/R26 suppress-all). Returns true when the contact is suppressed.
   */
  private async isGloballySuppressed(email: string): Promise<boolean> {
    const res = await this.db.query<{ unsubscribed: boolean }>(
      `SELECT unsubscribed FROM sdk_contacts
        WHERE namespace = $1 AND lower(email) = $2 LIMIT 1`,
      [this.db.namespace, normalizeEmail(email)]
    );
    return res.rows[0]?.unsubscribed === true;
  }

  /**
   * Authoritative send gate (R26). Returns `true` only when this exact stream of this topic is
   * allowed to send to this contact. Denies when:
   *   - the contact is GLOBALLY suppressed (`sdk_contacts.unsubscribed = TRUE` — bounce, complaint,
   *     GDPR delete, or hosted-page unsubscribe), regardless of any per-topic consent, or
   *   - the contact has no mirror row for the topic (never provisioned → deny-by-default), or
   *   - the requested stream is `opt_out` or `unsubscribed`, or
   *   - EITHER stream is `unsubscribed` (the global "everything" suppress dominates both streams).
   *
   * The gate reads the local mirror only — never Resend — so it is cheap and deterministic.
   * Reconcile (U14) is what keeps the mirror honest against Resend's hosted page.
   */
  async gate(email: string, topicKey: string, stream: Stream): Promise<boolean> {
    // Global suppression dominates everything (R22/R26). Checked FIRST so a bounced/complained/
    // erased contact is denied on BOTH lanes even when this topic has no consent row — the consent
    // row alone never sees a global suppression that fanned in via the contact flag.
    if (await this.isGloballySuppressed(email)) return false;

    const row = await this.read(email, topicKey);
    if (row === null) return false; // deny-by-default: no provisioned consent
    // A global unsubscribe is recorded as `unsubscribed` on every stream (see `set`), so an
    // `unsubscribed` on the OTHER stream also denies here — suppress-all dominates.
    if (row.digest === "unsubscribed" || row.alert === "unsubscribed") return false;
    const current = stream === "digest" ? row.digest : row.alert;
    return current === "opt_in";
  }

  /**
   * The single consent write path (origin R26/R28). Writes the mirror FIRST (monotonic-merge
   * upsert), THEN awaits the Resend `contacts.topics.update` push so an unsubscribe is confirmed
   * before the caller proceeds. A push failure marks the row reconcile-dirty and is reported in
   * the result — it never throws into the caller (fail-soft external sync).
   *
   * Monotonic merge: the stored stream value only moves toward MORE suppression. A stale `opt_in`
   * against a stored `unsubscribed`/`opt_out` is a no-op (`changed: false`). An `unsubscribed`
   * write dominates BOTH streams and sets the contact's global suppression flag (R26 suppress-all).
   */
  async set(input: ConsentSetInput): Promise<ConsentSetResult> {
    // Normalize the email at this write boundary so the consent row keys on the same string the
    // gate read (and the webhook resolve) use — a mixed-case write and a lowercased suppression
    // must converge on one row (residual casing fix).
    const email = normalizeEmail(input.email);
    const contact = this.db.namespaceKey(email);
    const isGlobalUnsub = input.status === "unsubscribed";

    // ----- 1. Mirror write (monotonic merge, atomic upsert) ------------------------------------
    // The upsert seeds defaults on insert, then on conflict applies the per-stream monotonic merge
    // in SQL so a concurrent writer cannot regress the other stream. `GREATEST` over the rank of
    // (stored, incoming) keeps the more-suppressed value; an `unsubscribed` write forces BOTH
    // streams to `unsubscribed` regardless of their current rank.
    const wantDigest =
      isGlobalUnsub || input.stream === "digest" ? input.status : null;
    const wantAlert = isGlobalUnsub || input.stream === "alert" ? input.status : null;

    // dirty_since: if we will push (resend enabled + topic id present) and it confirms, we clear
    // it below; if there is no topic id we mark dirty now so reconcile resolves it. We always
    // INSERT with dirty so a crash between mirror-write and push leaves a row reconcile will fix.
    const res = await this.db.execWrite<RawConsentRow>(
      `INSERT INTO sdk_topic_consent
         (namespace, contact, topic_key, topic_id, digest_status, alert_status, dirty_since, updated_at)
       VALUES ($1, $2, $3, $4,
               COALESCE($5, 'opt_in'),
               COALESCE($6, 'opt_in'),
               NOW(), NOW())
       ON CONFLICT (namespace, contact, topic_key) DO UPDATE SET
         topic_id = COALESCE(EXCLUDED.topic_id, sdk_topic_consent.topic_id),
         digest_status = CASE
           WHEN $5 IS NULL THEN sdk_topic_consent.digest_status
           WHEN ${rankCase("$5")} >= ${rankCase("sdk_topic_consent.digest_status")}
             THEN $5
           ELSE sdk_topic_consent.digest_status
         END,
         alert_status = CASE
           WHEN $6 IS NULL THEN sdk_topic_consent.alert_status
           WHEN ${rankCase("$6")} >= ${rankCase("sdk_topic_consent.alert_status")}
             THEN $6
           ELSE sdk_topic_consent.alert_status
         END,
         dirty_since = NOW(),
         updated_at = NOW()
       RETURNING contact, topic_key, topic_id, digest_status, alert_status, dirty_since`,
      [this.db.namespace, contact, input.topicKey, input.topicId ?? null, wantDigest, wantAlert]
    );

    const stored = res.rows[0];
    if (!stored) {
      // Defensive: RETURNING should always yield the row. Treat as a hard write failure.
      throw new Error("[@catalystiq/envoy-sdk] consent.set failed to persist the mirror row.");
    }
    const beforeRow = mapRow(stored);

    // A global unsubscribe also flips the contact-level suppression flag (R26). This is monotonic:
    // we only ever set it true here (a re-subscribe is a separate, explicit host action).
    if (isGlobalUnsub) {
      await this.db.query(
        `UPDATE sdk_contacts SET unsubscribed = TRUE, dirty_since = NOW(), updated_at = NOW()
          WHERE namespace = $1 AND lower(email) = $2`,
        [this.db.namespace, email]
      );
    }

    // "changed" means the requested stream's stored value reflects our intent (the merge took it).
    // For an opt_in that lost to a stored unsubscribed/opt_out, the stream still shows the
    // dominant value → not changed.
    const requestedAfter =
      input.stream === "digest" ? beforeRow.digest : beforeRow.alert;
    const changed = requestedAfter === input.status;

    // ----- 2. Resend push (awaited; fail-soft → mark dirty) ------------------------------------
    const topicId = beforeRow.topicId;
    const client = this.resend.client();
    if (!this.resend.enabled || client === null) {
      // No Resend (key unset): nothing to push. Per R43 this is a silent no-op; leave the row
      // dirty so a later reconcile (with a key) pushes it.
      return { row: beforeRow, changed, push: "skipped" };
    }
    if (topicId === null) {
      // No cached topic id → nothing addressable to push. Leave dirty for reconcile (which
      // resolves the topic id via provisioning) and report skipped.
      return { row: beforeRow, changed, push: "skipped" };
    }

    try {
      // Push the per-stream subscription for THIS stream. An `unsubscribed` maps to `opt_out` at
      // the topic level; the global flag (set above) is what stops the recipient everywhere.
      const subscription = toResendSubscription(
        input.stream === "digest" ? beforeRow.digest : beforeRow.alert
      );
      const { error } = await client.contacts.topics.update({
        email,
        topics: [{ id: topicId, subscription }],
      });
      if (error) {
        // Resend reports errors in-band (no throw). A failed push is fail-soft: keep the mirror
        // (already written), leave the row dirty, and report it. Never throw into the caller.
        return { row: { ...beforeRow, dirty: true }, changed, push: "dirty" };
      }
    } catch {
      // A thrown transport error is treated identically: fail-soft, row stays dirty.
      return { row: { ...beforeRow, dirty: true }, changed, push: "dirty" };
    }

    // Push confirmed → clear the dirty flag (the mirror and Resend now agree for this row).
    await this.db.query(
      `UPDATE sdk_topic_consent SET dirty_since = NULL, updated_at = NOW()
        WHERE namespace = $1 AND contact = $2 AND topic_key = $3`,
      [this.db.namespace, contact, input.topicKey]
    );
    return { row: { ...beforeRow, dirty: false }, changed, push: "confirmed" };
  }
}

/**
 * Emit a SQL fragment that maps a `ConsentStatus`-valued expression to its numeric suppression
 * rank, so the upsert can do the monotonic `GREATEST`-style compare in-database. `expr` is either
 * a bound-param placeholder (`$5`) or a column reference. A null/unknown value sorts lowest so it
 * never wins a merge.
 *
 * Exported so the broadcast reconcile sweep (which performs the SAME monotonic opt_out merge in
 * SQL) imports this one definition rather than re-deriving an identical fragment — a single source
 * of truth for the suppression-rank ordering both write paths depend on.
 */
export function rankCase(expr: string): string {
  return `CASE ${expr}
            WHEN 'unsubscribed' THEN 2
            WHEN 'opt_out' THEN 1
            WHEN 'opt_in' THEN 0
            ELSE -1
          END`;
}

/** Construct a consent mirror bound to a namespaced DB + Resend handle. */
export function createConsentMirror(
  db: NamespacedDb,
  resend: ResendClientHandle
): ConsentMirror {
  return new ConsentMirror(db, resend);
}

// Surface the rank table for tests / sibling modules that need to reason about merge dominance
// without re-deriving it.
export const CONSENT_RANK: Readonly<Record<ConsentStatus, number>> = Object.freeze({ ...RANK });
