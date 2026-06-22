import "server-only";

// Contacts lifecycle — enroll, SegmentSync push, GDPR deletion (U7 / origin R8, R9, R10, R11, R34, R37).
//
// This is the EVENT-DRIVEN entry into Envoy: the host calls `enroll({ email, data }, sequenceKey)`
// from its own application events (R8). Envoy keeps a minimal LOCAL mirror of the contact (email,
// host JSON `data`, Resend contact ref, per-sequence enrollment state — R9) and reflects the same
// contact into Resend so the broadcast lane can reach it (R10): a global Resend Contact, base
// Segment membership, and Topic opt-state.
//
// Three invariants:
//   1. IDEMPOTENT ENROLL (R11). Enrolling a contact already ACTIVE in the sequence is a no-op that
//      returns the existing enrollment and sends nothing new. The enrollment upsert is a
//      claim-on-conflict; an already-active row is reported `created: false`.
//   2. PUSH-ON-WRITE, FAIL-SOFT (R37). `sync.push` upserts the global Contact → base Segment →
//      Topic opt-state, ALL AWAITED. A partial failure NEVER throws into the host: it marks the
//      contact row reconcile-dirty (`sdk_contacts.dirty_since = NOW()`) and returns a non-throwing
//      status the reconcile sweep (U14) later repairs. This mirrors the consent-mirror fail-soft
//      contract — await the push, mark dirty on partial failure, never throw.
//   3. SUPPRESS-BEFORE-DELETE (R34). `contacts.delete` writes mirror suppression FIRST (so the next
//      reconcile excludes the contact and a stale `topics.list` read cannot resurrect them), then
//      best-effort deletes the Resend Contact + Segment/Topic membership (fail-soft).

import type { Envoy } from "./config.js";
import { createConsentMirror, type Stream } from "./consent/mirror.js";
import { normalizeEmail } from "./db/pool.js";
import { provisionTopic } from "./resend/topics.js";
import { addToSegment, removeFromSegment } from "./resend/segments.js";

// ---------------------------------------------------------------------------------------------
// Mirror contact upsert (R9) — the local authoritative record
// ---------------------------------------------------------------------------------------------

/** Host-supplied contact: an email plus arbitrary JSON `data` Envoy mirrors verbatim (R9). */
export interface ContactInput {
  email: string;
  data?: Record<string, unknown>;
}

/**
 * Upsert the mirror contact row (R9). MONOTONIC on suppression: an existing `unsubscribed = TRUE`
 * is never flipped back to false by an upsert (a re-subscribe is a separate explicit host action,
 * R26). `data` is merged shallow (new keys win) so re-enrolling with fresh data updates the mirror
 * without clobbering an existing unsubscribe. Returns the resulting `unsubscribed` flag so the
 * caller can short-circuit a suppressed contact.
 */
async function upsertMirrorContact(
  envoy: Envoy,
  input: ContactInput
): Promise<{ unsubscribed: boolean }> {
  const data = input.data ?? {};
  const res = await envoy.db.execWrite<{ unsubscribed: boolean }>(
    `INSERT INTO sdk_contacts (namespace, email, data, unsubscribed, created_at, updated_at)
     VALUES ($1, $2, $3::jsonb, FALSE, NOW(), NOW())
     ON CONFLICT (namespace, email) DO UPDATE SET
       data = sdk_contacts.data || EXCLUDED.data,
       updated_at = NOW()
     RETURNING unsubscribed`,
    [envoy.db.namespace, input.email, JSON.stringify(data)]
  );
  const row = res.rows[0];
  if (!row) {
    throw new Error("[@catalystiq/envoy-sdk] enroll failed to persist the mirror contact row.");
  }
  return { unsubscribed: row.unsubscribed === true };
}

/** Mark the contact row reconcile-dirty (idempotent re-stamp). The reconcile sweep (U14) keys off
 * `dirty_since IS NOT NULL`. */
async function markContactDirty(envoy: Envoy, email: string): Promise<void> {
  await envoy.db.query(
    `UPDATE sdk_contacts SET dirty_since = NOW(), updated_at = NOW()
       WHERE namespace = $1 AND email = $2`,
    [envoy.db.namespace, email]
  );
}

/** Persist the Resend contact id onto the mirror row once a global Contact upsert returns one. */
async function setResendContactId(
  envoy: Envoy,
  email: string,
  resendContactId: string
): Promise<void> {
  await envoy.db.query(
    `UPDATE sdk_contacts SET resend_contact_id = $3, updated_at = NOW()
       WHERE namespace = $1 AND email = $2`,
    [envoy.db.namespace, email, resendContactId]
  );
}

// ---------------------------------------------------------------------------------------------
// SegmentSync — push-on-write sync to Resend (R37)
// ---------------------------------------------------------------------------------------------

/** A topic to reflect during a push: identified by `(stream, subject)`, with the opt-state to set. */
export interface SyncTopic {
  stream: Stream;
  subject: string;
  /** Subscription to push for this topic. Defaults to `opt_in` (topics are subscribe-by-default). */
  subscription?: "opt_in" | "opt_out";
}

/** Inputs to a single `sync.push`. */
export interface SyncPushInput {
  email: string;
  /** Optional topic to provision + push opt-state for. Omit for a Contact + Segment only push. */
  topic?: SyncTopic;
}

/** Result of a `sync.push`. `ok` is true only when EVERY awaited step confirmed. */
export interface SyncPushResult {
  ok: boolean;
  /** True when any step failed and the contact row was marked reconcile-dirty. */
  dirty: boolean;
  /** Per-step outcomes for observability (no PII). */
  steps: {
    contact: "confirmed" | "failed" | "skipped";
    segment: "confirmed" | "failed" | "skipped";
    topic: "confirmed" | "failed" | "skipped" | "none";
  };
}

/**
 * The push-on-write SegmentSync primitive (R37). Build one per install via {@link createSegmentSync}.
 * Every `push` upserts the global Contact, adds the contact to the base Segment, and (when a topic
 * is given) provisions the Topic + pushes its opt-state — ALL AWAITED, fail-soft.
 */
export class SegmentSync {
  constructor(private readonly envoy: Envoy) {}

  /**
   * Push a contact's Resend reflection. Order: global Contact upsert → base Segment add → Topic
   * opt-state. Each step is awaited; a Resend-unset key makes the whole push a silent no-op
   * (`ok: false`, dirty left for reconcile). Any partial failure marks the contact row dirty and
   * returns `{ ok: false, dirty: true }` WITHOUT throwing (R37).
   */
  async push(input: SyncPushInput): Promise<SyncPushResult> {
    const { config, resend } = this.envoy;
    const steps: SyncPushResult["steps"] = {
      contact: "skipped",
      segment: "skipped",
      topic: input.topic ? "skipped" : "none",
    };

    const client = resend.client();
    if (!resend.enabled || client === null) {
      // No Resend (key unset): nothing to push. Per R43 a silent no-op; the contact row is left
      // dirty so a later reconcile (with a key) pushes it. We mark dirty so the sweep repairs it.
      await markContactDirty(this.envoy, input.email);
      return { ok: false, dirty: true, steps };
    }

    let allOk = true;

    // 1. Global Contact upsert. Adding the base Segment at create time is the cheapest path, but we
    //    also call segments.add explicitly below so a PRE-EXISTING contact (create reports a
    //    conflict / already-exists) still gets the membership. Resend's create is upsert-ish; we
    //    treat an in-band error as a step failure (fail-soft).
    try {
      const { data, error } = await client.contacts.create({
        email: input.email,
        unsubscribed: false,
        segments: [{ id: config.baseSegmentId }],
      });
      if (error || !data) {
        steps.contact = "failed";
        allOk = false;
      } else {
        steps.contact = "confirmed";
        await setResendContactId(this.envoy, input.email, data.id);
      }
    } catch {
      steps.contact = "failed";
      allOk = false;
    }

    // 2. Base Segment membership (explicit — idempotent for an already-member contact). This covers
    //    the case where the contact already existed and create did not (re)apply the segment.
    const seg = await addToSegment(resend, input.email, config.baseSegmentId);
    if (seg.ok) {
      steps.segment = "confirmed";
    } else {
      steps.segment = seg.skipped ? "skipped" : "failed";
      if (!seg.skipped) allOk = false;
    }

    // 3. Topic opt-state (optional). Provision the Topic idempotently (cached id), then push the
    //    contact's per-topic subscription. A provisioning or push failure is fail-soft.
    if (input.topic) {
      try {
        const provisioned = await provisionTopic(this.envoy.db, resend, {
          stream: input.topic.stream,
          subject: input.topic.subject,
        });
        const { error } = await client.contacts.topics.update({
          email: input.email,
          topics: [
            { id: provisioned.topicId, subscription: input.topic.subscription ?? "opt_in" },
          ],
        });
        if (error) {
          steps.topic = "failed";
          allOk = false;
        } else {
          steps.topic = "confirmed";
        }
      } catch {
        steps.topic = "failed";
        allOk = false;
      }
    }

    if (!allOk) {
      await markContactDirty(this.envoy, input.email);
      return { ok: false, dirty: true, steps };
    }
    return { ok: true, dirty: false, steps };
  }
}

/** Construct a SegmentSync bound to an Envoy install. */
export function createSegmentSync(envoy: Envoy): SegmentSync {
  return new SegmentSync(envoy);
}

// ---------------------------------------------------------------------------------------------
// enroll (R8, R10, R11)
// ---------------------------------------------------------------------------------------------

/** Result of an {@link enroll}. `created: false` ⇒ an idempotent no-op re-enroll (R11). */
export interface EnrollResult {
  /** The (bare) contact email. */
  email: string;
  /** The sequence the contact is enrolled in. */
  sequenceKey: string;
  /** Enrollment status (`active` for a fresh or already-active enrollment). */
  status: string;
  /** True when this call created the enrollment; false when it already existed (no-op, R11). */
  created: boolean;
  /** True when the contact is globally suppressed — enrollment is recorded but no sync/send occurs. */
  suppressed: boolean;
  /** The SegmentSync push outcome, or `null` when skipped (already active, or suppressed). */
  sync: SyncPushResult | null;
}

/** Options for {@link enroll}. */
export interface EnrollOptions {
  /** Topic to reflect into Resend for this enrollment (provision + opt-state push). */
  topic?: SyncTopic;
  /**
   * The stream the drip lane will send this sequence on (R27). Defaults to `"digest"` — drip
   * sequences are opt-in nurture, matching the drip engine's `stream` default. Used to seed the
   * LOCAL consent row the send gate reads, so the gate passes without a separate `consent.set`.
   */
  stream?: Stream;
}

interface EnrollmentRow {
  status: string;
  current_step: number;
}

/**
 * Enroll a contact into a sequence (R8). Steps:
 *   1. Upsert the mirror contact (R9). A globally-suppressed contact still records the enrollment
 *      but performs NO Resend sync and is reported `suppressed: true` (the send gate denies later).
 *   2. Claim the enrollment row (R11). A FRESH claim (`created: true`) proceeds to sync; an
 *      already-ACTIVE enrollment is an idempotent no-op (`created: false`, `sync: null`) — nothing
 *      new is sent (R11).
 *   3. On a fresh enrollment, run `sync.push` (Contact → base Segment → Topic opt-state), awaited
 *      and fail-soft (R10/R37).
 *
 * Never throws on a Resend failure — the sync result carries the dirty flag. Throws only on a hard
 * mirror-write failure (a contract violation, not an external-service hiccup).
 *
 * Consent seeding (drip-lane correctness): a fresh, non-suppressed enrollment ALSO seeds a LOCAL
 * `opt_in` consent row for `(email, sequenceKey)` on the drip stream via `mirror.set`. The drip
 * send gate (U6) reads that local mirror and denies-by-default when no row exists — without this
 * seed every drip step would be suppressed until the host separately called `consent.set`. The seed
 * is a monotonic `opt_in`, so it never resurrects a recipient who already unsubscribed.
 */
export async function enroll(
  envoy: Envoy,
  contact: ContactInput,
  sequenceKey: string,
  options: EnrollOptions = {}
): Promise<EnrollResult> {
  if (typeof sequenceKey !== "string" || sequenceKey.length === 0) {
    throw new Error("[@catalystiq/envoy-sdk] enroll requires a non-empty sequenceKey.");
  }

  // Normalize the email at this entry boundary so the mirror contact, enrollment key, consent seed,
  // and Resend sync all key on the same string (residual casing fix). Build a normalized contact so
  // the mirror upsert stores the lowercased email too.
  const email = normalizeEmail(contact.email);
  if (email.length === 0) {
    throw new Error("[@catalystiq/envoy-sdk] enroll requires a non-empty email.");
  }
  const normalizedContact: ContactInput = { email, data: contact.data };
  const stream: Stream = options.stream ?? "digest";

  // 1. Mirror contact upsert (R9).
  const { unsubscribed } = await upsertMirrorContact(envoy, normalizedContact);

  // 2. Claim the enrollment (R11). `contact` column on sdk_enrollments stores the namespaced key,
  //    matching sdk_topic_consent's convention. ON CONFLICT DO NOTHING ⇒ a re-enroll of an existing
  //    row loses the claim (count 0); we then read the existing row to report its status.
  const namespacedContact = envoy.db.namespaceKey(email);
  const claim = await envoy.db.execWrite<EnrollmentRow>(
    `INSERT INTO sdk_enrollments (namespace, contact, sequence_key, status, current_step, data, enrolled_at, updated_at)
     VALUES ($1, $2, $3, 'active', 0, $4::jsonb, NOW(), NOW())
     ON CONFLICT (namespace, contact, sequence_key) DO NOTHING
     RETURNING status, current_step`,
    [envoy.db.namespace, namespacedContact, sequenceKey, JSON.stringify(contact.data ?? {})]
  );

  if (claim.count === 0) {
    // Already enrolled — idempotent no-op (R11). Report the existing status; send/sync nothing new.
    const existing = await envoy.db.query<EnrollmentRow>(
      `SELECT status, current_step FROM sdk_enrollments
         WHERE namespace = $1 AND contact = $2 AND sequence_key = $3`,
      [envoy.db.namespace, namespacedContact, sequenceKey]
    );
    const status = existing.rows[0]?.status ?? "active";

    // Self-heal a half-written prior enroll (re-enroll seed gap): the original enroll could have
    // crashed AFTER the enrollment INSERT but BEFORE seeding the opt_in consent row, leaving an
    // active enrollment that the send gate (which denies-by-default with no consent row) silently
    // suppresses forever. A re-enroll is the natural repair point — if the contact is NOT globally
    // suppressed and NO consent row exists for (email, sequenceKey), seed the monotonic opt_in row
    // now. We only seed when the row is ABSENT, so a contact who explicitly unsubscribed this topic
    // (a present opt_out/unsubscribed row) is never resurrected.
    if (!unsubscribed) {
      const mirror = createConsentMirror(envoy.db, envoy.resend);
      const consent = await mirror.read(email, sequenceKey);
      if (consent === null) {
        await mirror.set({ email, topicKey: sequenceKey, stream, status: "opt_in" });
      }
    }

    return {
      email,
      sequenceKey,
      status,
      created: false,
      suppressed: unsubscribed,
      sync: null,
    };
  }

  // 3. Fresh enrollment. A suppressed contact records the enrollment but does NOT sync to Resend
  //    (it would be re-adding a contact the recipient asked to stop). The send gate (U6) denies the
  //    actual send; here we simply skip the push AND the consent seed.
  if (unsubscribed) {
    return {
      email,
      sequenceKey,
      status: "active",
      created: true,
      suppressed: true,
      sync: null,
    };
  }

  // 3a. Seed the LOCAL opt_in consent row for the drip topic (= sequenceKey) so the send gate passes
  //     without a separate host consent.set. Monotonic merge: `opt_in` never lowers a stored
  //     unsubscribed/opt_out, so a previously-suppressed contact stays suppressed. No topic id is
  //     known here, so mirror.set writes the local row and skips the Resend push (reconcile resolves
  //     the topic id and pushes later) — exactly the local-gate row the drip lane needs.
  const mirror = createConsentMirror(envoy.db, envoy.resend);
  await mirror.set({ email, topicKey: sequenceKey, stream, status: "opt_in" });

  const sync = createSegmentSync(envoy);
  const pushed = await sync.push({ email, topic: options.topic });

  return {
    email,
    sequenceKey,
    status: "active",
    created: true,
    suppressed: false,
    sync: pushed,
  };
}

// ---------------------------------------------------------------------------------------------
// contacts.delete — right-to-erasure (R34)
// ---------------------------------------------------------------------------------------------

/** Result of a {@link deleteContact}. Each best-effort Resend teardown is reported independently. */
export interface DeleteContactResult {
  email: string;
  /** True once the mirror was suppressed (always attempted first; throws only on a hard DB failure). */
  suppressed: boolean;
  /** The captured Resend contact id (or null when the contact was never reflected to Resend). */
  resendContactId: string | null;
  /** Best-effort teardown outcomes. `skipped` ⇒ Resend unset or nothing to delete. */
  resendContactDeleted: "deleted" | "failed" | "skipped";
  segmentMembershipRemoved: "removed" | "failed" | "skipped";
  topicMembershipCleared: "cleared" | "failed" | "skipped";
  /** True once the contact's enrollment/step PII columns were purged (R34 GDPR erasure). */
  piiPurged: boolean;
}

/** Read the captured Resend contact id + suppression flag for a contact, or null if absent. */
async function readContactMeta(
  envoy: Envoy,
  email: string
): Promise<{ resendContactId: string | null } | null> {
  const res = await envoy.db.query<{ resend_contact_id: string | null }>(
    `SELECT resend_contact_id FROM sdk_contacts WHERE namespace = $1 AND lower(email) = $2 LIMIT 1`,
    [envoy.db.namespace, email]
  );
  const row = res.rows[0];
  return row ? { resendContactId: row.resend_contact_id } : null;
}

/**
 * Atomically suppress AND erase a contact (R34 GDPR erasure) in ONE statement. The injected pool
 * has no transaction surface, so a single data-modifying CTE is the only way to make erasure atomic:
 * if any part fails, none of it commits, and we never report `piiPurged: true` for a half-erased
 * contact. Previously this ran as four independent writes — a crash between them could leave the
 * contact's `sdk_enrollments.data` snapshot (host PII) intact while the caller still set
 * `piiPurged = true`. The CTE binds suppression + the fan-out + the PII wipe together:
 *
 *   - `enr_ids`        — the enrollment ids for this contact (drives the step PII clear).
 *   - `step_clear`     — null `sdk_steps.last_error` / `agent_session_id` for those enrollments (FK child first).
 *   - `enr_purge`      — null `sdk_enrollments.data` (the host JSON snapshot).
 *   - `contact_suppress` — flip `sdk_contacts.unsubscribed = TRUE` + mark dirty.
 *   - outer            — fan the suppression into every per-topic consent row (BOTH streams →
 *                        terminal `unsubscribed`, monotonic), so the gate denies both lanes at once.
 *
 * The mirror/enrollment/step ROWS themselves stay (the suppressed mirror is the exclusion guarantee);
 * only the PII-bearing columns are wiped.
 */
async function eraseContact(envoy: Envoy, email: string): Promise<void> {
  const namespacedContact = envoy.db.namespaceKey(email);
  await envoy.db.query(
    `WITH enr_ids AS (
       SELECT id FROM sdk_enrollments
        WHERE namespace = $1 AND lower(contact) = lower($3)
     ),
     step_clear AS (
       UPDATE sdk_steps
          SET last_error = NULL, agent_session_id = NULL, updated_at = NOW()
        WHERE namespace = $1 AND enrollment_id IN (SELECT id FROM enr_ids)
        RETURNING id
     ),
     enr_purge AS (
       UPDATE sdk_enrollments
          SET data = '{}'::jsonb, updated_at = NOW()
        WHERE namespace = $1 AND lower(contact) = lower($3)
        RETURNING id
     ),
     contact_suppress AS (
       UPDATE sdk_contacts
          SET unsubscribed = TRUE, dirty_since = NOW(), updated_at = NOW()
        WHERE namespace = $1 AND lower(email) = $2
        RETURNING email
     )
     UPDATE sdk_topic_consent
        SET digest_status = 'unsubscribed',
            alert_status = 'unsubscribed',
            dirty_since = NOW(),
            updated_at = NOW()
      WHERE namespace = $1 AND lower(contact) = lower($3)`,
    [envoy.db.namespace, email, namespacedContact]
  );
}

/**
 * Host-invoked right-to-erasure (R34). Order is load-bearing:
 *   1. SUPPRESS THE MIRROR FIRST. This guarantees the next reconcile excludes the contact and a
 *      stale `topics.list` read cannot reconcile a deleted contact back to active (suppress-before-
 *      delete). This step is the only one that may throw (a hard DB failure) — everything after is
 *      best-effort and fail-soft.
 *   2. Capture the Resend contact id from the mirror (before the row is anything but suppressed).
 *   3. Best-effort delete the Resend Contact + Segment/Topic membership. Each is independent and
 *      fail-soft: a Resend error on one does not abort the others, and NONE throw (R34). An already-
 *      accepted broadcast cannot be recalled — that residual is acknowledged, not handled here.
 *
 * Note: the local mirror row is intentionally LEFT in place (suppressed), not hard-deleted — the
 * SDK never hard-deletes rows (the suppressed mirror is what keeps the contact excluded across both
 * lanes). The host's own data-retention policy governs purging the mirror row itself.
 */
export async function deleteContact(
  envoy: Envoy,
  rawEmail: string,
  options: { segmentIds?: string[]; topicIds?: string[] } = {}
): Promise<DeleteContactResult> {
  if (typeof rawEmail !== "string" || rawEmail.length === 0) {
    throw new Error("[@catalystiq/envoy-sdk] contacts.delete requires a non-empty email.");
  }
  // Normalize at the boundary so suppression + purge match the rows enroll/webhook wrote regardless
  // of the case the caller passed (residual casing fix).
  const email = normalizeEmail(rawEmail);

  // 1. Suppress AND erase ATOMICALLY (R34). One CTE flips the mirror suppression, fans it into every
  //    per-topic consent row (gate denies both lanes), AND wipes the PII columns (enrollment data
  //    snapshot + step error/marker). May throw on a hard DB failure — that is correct: we must not
  //    proceed to the best-effort Resend teardown if we could not record suppression + erasure
  //    locally. `piiPurged` is set to true ONLY after the statement resolves, so a thrown/partial
  //    erasure never reports `piiPurged: true`.
  let piiPurged = false;
  await eraseContact(envoy, email);
  piiPurged = true;

  // 2. Capture the Resend contact id.
  const meta = await readContactMeta(envoy, email);
  const resendContactId = meta?.resendContactId ?? null;

  const result: DeleteContactResult = {
    email,
    suppressed: true,
    resendContactId,
    resendContactDeleted: "skipped",
    segmentMembershipRemoved: "skipped",
    topicMembershipCleared: "skipped",
    piiPurged,
  };

  const client = envoy.resend.client();
  if (!envoy.resend.enabled || client === null) {
    // Resend unset — mirror suppression done, nothing to tear down upstream. Fail-soft no-op.
    return result;
  }

  // 3a. Best-effort: remove from the base Segment + any host-named extra Segments.
  const segmentIds = options.segmentIds ?? [envoy.config.baseSegmentId];
  let segOk = true;
  let segAttempted = false;
  for (const segmentId of segmentIds) {
    if (!segmentId) continue;
    segAttempted = true;
    const r = await removeFromSegment(envoy.resend, email, segmentId);
    if (!r.ok && !r.skipped) segOk = false;
  }
  result.segmentMembershipRemoved = !segAttempted ? "skipped" : segOk ? "removed" : "failed";

  // 3b. Best-effort: clear Topic membership by pushing every named topic to opt_out (a deleted
  //     contact must receive nothing). When no topic ids are named, this is a no-op (the contact
  //     delete below removes the contact entirely; topic teardown is belt-and-suspenders).
  if (options.topicIds && options.topicIds.length > 0) {
    try {
      const { error } = await client.contacts.topics.update({
        email,
        topics: options.topicIds.map((id) => ({ id, subscription: "opt_out" as const })),
      });
      result.topicMembershipCleared = error ? "failed" : "cleared";
    } catch {
      result.topicMembershipCleared = "failed";
    }
  }

  // 3c. Best-effort: delete the global Resend Contact (by email — Resend accepts the email form).
  try {
    const { error } = await client.contacts.remove(email);
    result.resendContactDeleted = error ? "failed" : "deleted";
  } catch {
    result.resendContactDeleted = "failed";
  }

  return result;
}
