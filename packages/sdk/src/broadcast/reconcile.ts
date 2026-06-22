import "server-only";

// Reconcile sweep — topics diff + segment repair + cost control (U14 / origin R29, KTD9).
//
// Resend's hosted preference page is the place a recipient drops a single Topic. That action does
// NOT arrive as a topic-scoped webhook: the `contact.updated` payload carries the contact's GLOBAL
// state only (no `topic_id`, verified against resend@6.14.0). So per-topic opt-outs made on
// Resend's page are INVISIBLE to the webhook receiver (U5). Reconcile is how the SDK catches them:
// it pulls `contacts.topics.list` for a contact, diffs each topic's Resend subscription against the
// local mirror, and writes `opt_out` into the mirror for any topic Resend now reports opted-out
// (R29). An unmapped opt_out silently dropped is a CONSENT LEAK — so anything reconcile cannot map
// fails LOUD (the contact is marked reconcile-dirty and surfaced), never silently ignored.
//
// Reconcile ALSO repairs base-Segment membership (intersection targeting, R29/R10): a broadcast
// targets `(segmentId ∩ topicId)`, so a contact opted-in on the Topic but absent from the base
// Segment receives NOTHING. Reconcile re-adds such a contact to the base Segment so the intended
// audience actually receives the issue.
//
// Cost control (the sweep is bounded at scale):
//   - DIRTY-SET NARROWING. The per-tick sweep only visits contacts whose `sdk_contacts.dirty_since`
//     is set (the webhook / consent.set / enroll mark a contact dirty when its Resend state may have
//     drifted). The partial index `sdk_contacts_dirty_idx` makes that scan cheap.
//   - RESUMABLE FULL-SWEEP CURSOR. A periodic full sweep (every contact, not just the dirty ones)
//     walks the table ordered by `id` and persists its progress in `sdk_program_state` under a
//     reserved program key, so a tick that exhausts its per-tick budget resumes from where it left
//     off on the next tick rather than restarting from the top.
//   - 429 BACKOFF. A Resend 429 mid-sweep backs off (a short delay) and RESUMES the same contact —
//     it does not abort the issue. The dirty contact stays dirty, so the next tick retries it.
//
// Ordering: reconcile is the LAST step before `broadcasts.create` (it narrows the fan-out window —
// the window between reconcile and Resend resolving the broadcast audience cannot be fully closed,
// only narrowed; see the requirements doc's "Reconcile→fan-out consent window" residual).
//
// Patterns reimplemented (never imported, per R48): monotonic merge (the consent mirror, U6) — a
// reconcile only ever moves a topic toward MORE suppression (`opt_out`), never resurrects an
// opt_out back to opt_in; and the suppress-at-every-site / CAS-gate discipline from the CRM
// lifecycle learning.

import type { Envoy } from "../config.js";
import { rankCase, type ConsentStatus, type Stream } from "../consent/mirror.js";
import { addToSegment } from "../resend/segments.js";
import { TOPIC_CACHE_PROGRAM_KEY } from "../resend/topics.js";

// ---------------------------------------------------------------------------------------------
// Topic-id → (stream, subject) reverse map (U7 provisioning cache)
// ---------------------------------------------------------------------------------------------

// The U7 topic-id cache program key is imported from resend/topics.ts (the provisioning writer) so
// reconcile reads that same cache in reverse (topicId → topicKey) off ONE shared constant — see the
// `TOPIC_CACHE_PROGRAM_KEY` import above.

/** Reserved `sdk_program_state.program_key` under which the resumable full-sweep cursor lives. */
const SWEEP_CURSOR_PROGRAM_KEY = "__envoy_reconcile_sweep__";
/** Single subject key for the install-wide full-sweep cursor (there is one sweep per install). */
const SWEEP_CURSOR_SUBJECT_KEY = "default";

/**
 * One resolved topic-cache entry: the host-meaningful `(stream, subject)` for a Resend topic id.
 * `topicKey` is the canonical `stream:subject` string the consent mirror stores on `topic_key`.
 */
interface ResolvedTopic {
  topicId: string;
  topicKey: string;
  stream: Stream;
  subject: string;
}

/** Split a canonical `stream:subject` topic key back into its parts. The first `:` separates the
 * stream from the (possibly `:`-bearing) subject. A key without a recognized stream prefix is a
 * corrupt cache row — treat it as unmappable (the caller fails loud). */
function parseTopicKey(topicKey: string): { stream: Stream; subject: string } | null {
  const sep = topicKey.indexOf(":");
  if (sep <= 0) return null;
  const stream = topicKey.slice(0, sep);
  const subject = topicKey.slice(sep + 1);
  if ((stream !== "digest" && stream !== "alert") || subject.length === 0) return null;
  return { stream, subject };
}

/**
 * Build the install's `topicId → (stream, subject)` reverse map from the U7 provisioning cache. The
 * cache rows live in `sdk_program_state` under `program_key = "__envoy_topics__"` with
 * `subject_key = topicKey` and `watermark = topicId`. Reconcile reads the WHOLE set once per sweep
 * (the install's topic count is small and bounded) so each contact's `topics.list` diff is a pure
 * in-memory lookup. A cache row whose `watermark` (topic id) is null/empty is skipped (never
 * provisioned to a real id); a row whose `topic_key` is unparseable is skipped here and surfaces as
 * an unmapped entry downstream (fail loud), never silently treated as mapped.
 */
async function loadTopicCache(envoy: Envoy): Promise<Map<string, ResolvedTopic>> {
  const res = await envoy.db.query<{ subject_key: string; watermark: string | null }>(
    `SELECT subject_key, watermark FROM sdk_program_state
       WHERE namespace = $1 AND program_key = $2`,
    [envoy.db.namespace, TOPIC_CACHE_PROGRAM_KEY]
  );
  const map = new Map<string, ResolvedTopic>();
  for (const row of res.rows) {
    const topicId = row.watermark;
    if (typeof topicId !== "string" || topicId.length === 0) continue;
    const parts = parseTopicKey(row.subject_key);
    if (parts === null) continue; // corrupt key — leave it out so the entry surfaces as unmapped.
    map.set(topicId, {
      topicId,
      topicKey: row.subject_key,
      stream: parts.stream,
      subject: parts.subject,
    });
  }
  return map;
}

// ---------------------------------------------------------------------------------------------
// 429 backoff
// ---------------------------------------------------------------------------------------------

/** A thrown/returned Resend error that should trigger a backoff-and-resume rather than an abort. */
function isRateLimited(err: unknown): boolean {
  if (err === null || typeof err !== "object") return false;
  const e = err as { statusCode?: unknown; status?: unknown; name?: unknown; message?: unknown };
  if (e.statusCode === 429 || e.status === 429) return true;
  const name = typeof e.name === "string" ? e.name : "";
  const msg = typeof e.message === "string" ? e.message : "";
  return /rate.?limit|too.?many.?requests|\b429\b/i.test(`${name} ${msg}`);
}

const DEFAULT_BACKOFF_MS = 1000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------------------------
// Per-contact reconcile (the topics diff + segment repair)
// ---------------------------------------------------------------------------------------------

/** Why a single reconcile ended the way it did. */
export type ReconcileOutcome =
  /** The diff + segment repair completed; the contact row was cleared dirty. */
  | "reconciled"
  /** Resend is unset (no key) — nothing to diff; the contact stays dirty for a later run. */
  | "skipped"
  /** A 429 was hit; the caller backed off. The contact stays dirty (retried next tick). */
  | "rate_limited"
  /** A `topics.list` entry id was absent from the provisioning cache — fail loud. The contact stays
   *  dirty and is SURFACED (never silently ignored — an unmapped opt_out is a consent leak). */
  | "unmapped"
  /** A non-rate-limit Resend error occurred; the contact stays dirty (retried). */
  | "error";

/** Result of {@link reconcileContact}. Carries the observable changes (no PII beyond the email the
 * caller already holds) so a sweep can summarize what it repaired. */
export interface ReconcileContactResult {
  email: string;
  outcome: ReconcileOutcome;
  /** Topic keys whose mirror state reconcile flipped to `opt_out` (drift caught from Resend). */
  optedOut: string[];
  /** True when the base-Segment membership was (re-)asserted for this contact. */
  segmentRepaired: boolean;
  /** Topic ids on the contact in Resend that the provisioning cache could not map — the fail-loud
   *  signal. Non-empty ⇒ `outcome === "unmapped"`. */
  unmappedTopicIds: string[];
}

/** Inputs to {@link reconcileContact}. */
export interface ReconcileContactInput {
  email: string;
  /** Pre-loaded `topicId → (stream, subject)` map (built once per sweep via {@link loadTopicCache}).
   *  Pass it in to avoid re-querying the cache per contact. */
  topicCache: Map<string, ResolvedTopic>;
  /** Backoff before resume on a 429 (ms). Defaults to {@link DEFAULT_BACKOFF_MS}. Tests pass 0. */
  backoffMs?: number;
  /** Injectable sleep (tests stub it). Defaults to a real timer. */
  sleepFn?: (ms: number) => Promise<void>;
}

/**
 * Reconcile ONE contact: diff `contacts.topics.list` against the mirror and repair base-Segment
 * membership. The load-bearing steps, in order:
 *
 *   1. List the contact's topics from Resend (`contacts.topics.list`). A 429 here backs off and
 *      returns `rate_limited` WITHOUT clearing dirty (the next tick retries). A non-429 error
 *      returns `error`, also leaving dirty.
 *   2. For every listed topic, map its `id` to `(stream, subject)` via the provisioning cache. An
 *      id ABSENT from the cache is fail-loud: it is collected into `unmappedTopicIds`, the contact
 *      stays dirty, and the outcome is `unmapped` — we NEVER silently ignore it (a topic Resend
 *      reports opted-out that we cannot map is a consent leak we must surface).
 *   3. For every MAPPED topic Resend reports `opt_out`, write `opt_out` into the mirror (monotonic —
 *      `consent.set`-equivalent merge in SQL only moves toward MORE suppression).
 *   4. Repair base-Segment membership: re-assert the contact in the base Segment (idempotent add) so
 *      an opted-in contact missing from the Segment still receives the issue (intersection target).
 *   5. On a clean pass (no unmapped ids, no rate-limit/error), CLEAR the contact's dirty flag.
 *
 * Never throws on a Resend hiccup — every failure is folded into the typed outcome (fail-soft),
 * EXCEPT a hard DB write failure, which propagates (a mirror we cannot write is a contract
 * violation, not an external-service blip).
 */
export async function reconcileContact(
  envoy: Envoy,
  input: ReconcileContactInput
): Promise<ReconcileContactResult> {
  const { email, topicCache } = input;
  const result: ReconcileContactResult = {
    email,
    outcome: "reconciled",
    optedOut: [],
    segmentRepaired: false,
    unmappedTopicIds: [],
  };

  const client = envoy.resend.client();
  if (!envoy.resend.enabled || client === null) {
    // No Resend (key unset) — nothing to diff. Leave the contact dirty so a later run (with a key)
    // reconciles it. Not an error; a silent dev/CI no-op (R43).
    result.outcome = "skipped";
    return result;
  }

  const backoffMs = input.backoffMs ?? DEFAULT_BACKOFF_MS;
  const sleepFn = input.sleepFn ?? sleep;

  // ----- 1. List the contact's topics (paginated; 429-aware) ---------------------------------
  let listed: Array<{ id: string; subscription: ConsentStatus | "opt_in" | "opt_out" }>;
  try {
    listed = await listAllContactTopics(client, email);
  } catch (err) {
    if (isRateLimited(err)) {
      await sleepFn(backoffMs);
      result.outcome = "rate_limited";
      return result; // dirty preserved — next tick retries this contact.
    }
    result.outcome = "error";
    return result;
  }

  // ----- 2. Map ids → (stream, subject); collect unmapped ids (fail loud) ---------------------
  const flips: Array<{ resolved: ResolvedTopic; stream: Stream }> = [];
  for (const entry of listed) {
    const resolved = topicCache.get(entry.id);
    if (resolved === undefined) {
      // An out-of-band / cache-miss topic id. NEVER silently ignore — surface it (consent leak).
      result.unmappedTopicIds.push(entry.id);
      continue;
    }
    if (entry.subscription === "opt_out") {
      flips.push({ resolved, stream: resolved.stream });
    }
  }

  // ----- 3. Write opt_out into the mirror for each flipped (mapped) topic ----------------------
  for (const flip of flips) {
    await writeOptOut(envoy, email, flip.resolved, flip.stream);
    result.optedOut.push(flip.resolved.topicKey);
  }

  // ----- 4. Repair base-Segment membership (intersection targeting) ---------------------------
  // A 429 on the segment add backs off + resumes (does not abort). A non-rate-limit failure leaves
  // the contact dirty (segment unrepaired) so the next tick retries.
  const seg = await addToSegment(envoy.resend, email, envoy.config.baseSegmentId);
  if (seg.ok) {
    result.segmentRepaired = true;
  } else if (!seg.skipped && seg.reason !== undefined && /429|rate/i.test(seg.reason)) {
    await sleepFn(backoffMs);
    result.outcome = "rate_limited";
    return result; // dirty preserved.
  }

  // ----- 5. Resolve the outcome + clear dirty on a clean pass ---------------------------------
  if (result.unmappedTopicIds.length > 0) {
    // Fail loud: a topic id we could not map. Keep the contact dirty + re-stamp so the sweep keeps
    // surfacing it until provisioning is repaired. Do NOT clear dirty (the consent leak persists).
    await markContactDirty(envoy, email);
    result.outcome = "unmapped";
    return result;
  }

  // Clean pass — the mirror and Resend agree for this contact. Clear the dirty flag.
  await clearContactDirty(envoy, email);
  result.outcome = "reconciled";
  return result;
}

/**
 * Page through `contacts.topics.list` for a contact, accumulating every entry. Pagination is
 * cursor-based in resend@6.14.0 (`after` / `has_more`). A contact's topic count is small in
 * practice; the loop is bounded by a max-pages budget so a pathological `has_more === true` cannot
 * spin forever. A Resend in-band error is thrown so the caller's 429/err handling sees it.
 */
async function listAllContactTopics(
  client: NonNullable<ReturnType<Envoy["resend"]["client"]>>,
  email: string
): Promise<Array<{ id: string; subscription: "opt_in" | "opt_out" }>> {
  const out: Array<{ id: string; subscription: "opt_in" | "opt_out" }> = [];
  const MAX_PAGES = 50;
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, error } = await client.contacts.topics.list({ email, after });
    if (error) {
      // Surface as a thrown error so reconcileContact's try/catch classifies 429 vs other.
      throw error;
    }
    const list = data?.data ?? [];
    for (const t of list) {
      out.push({ id: t.id, subscription: t.subscription });
    }
    if (data?.has_more !== true || list.length === 0) break;
    // Cursor forward by the last entry's id (Resend's cursor is the resource id).
    after = list[list.length - 1]?.id;
    if (after === undefined) break;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Mirror writes (monotonic opt_out) + dirty management
// ---------------------------------------------------------------------------------------------

/**
 * Write `opt_out` into the mirror for one `(contact, topic, stream)`, MONOTONICALLY (never regresses
 * a stored `unsubscribed` back to `opt_out`, and a stored `opt_out` stays). This mirrors the
 * consent-mirror merge (U6): the stored stream value only moves toward MORE suppression. The row is
 * upserted (it may not exist yet if the topic was provisioned out-of-band on Resend) and the topic
 * id is recorded so a later push can address it. The row is left CLEAN for this stream (reconcile
 * IS the repair — the mirror now matches Resend), but the CONTACT-level dirty flag is cleared
 * separately by the caller after the whole diff lands.
 */
async function writeOptOut(
  envoy: Envoy,
  email: string,
  topic: ResolvedTopic,
  stream: Stream
): Promise<void> {
  const contact = envoy.db.namespaceKey(email);
  const wantDigest: ConsentStatus | null = stream === "digest" ? "opt_out" : null;
  const wantAlert: ConsentStatus | null = stream === "alert" ? "opt_out" : null;

  const res = await envoy.db.execWrite(
    `INSERT INTO sdk_topic_consent
       (namespace, contact, topic_key, topic_id, digest_status, alert_status, dirty_since, updated_at)
     VALUES ($1, $2, $3, $4,
             COALESCE($5, 'opt_in'),
             COALESCE($6, 'opt_in'),
             NULL, NOW())
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
       dirty_since = NULL,
       updated_at = NOW()
     RETURNING contact`,
    [envoy.db.namespace, contact, topic.topicKey, topic.topicId, wantDigest, wantAlert]
  );
  if (res.count === 0) {
    throw new Error("[@catalystiq/envoy-sdk] reconcile failed to persist the opt_out mirror row.");
  }
}

/** Clear a contact's reconcile-dirty flag (the diff landed clean). Keyed by bare email — the dirty
 * flag lives on `sdk_contacts`, not the per-topic consent rows. */
async function clearContactDirty(envoy: Envoy, email: string): Promise<void> {
  await envoy.db.query(
    `UPDATE sdk_contacts SET dirty_since = NULL, updated_at = NOW()
       WHERE namespace = $1 AND email = $2`,
    [envoy.db.namespace, email]
  );
}

/** Re-stamp a contact's reconcile-dirty flag (idempotent). Used to keep an UNMAPPED contact
 * surfaced until provisioning is repaired. */
async function markContactDirty(envoy: Envoy, email: string): Promise<void> {
  await envoy.db.query(
    `UPDATE sdk_contacts SET dirty_since = NOW(), updated_at = NOW()
       WHERE namespace = $1 AND email = $2`,
    [envoy.db.namespace, email]
  );
}

// ---------------------------------------------------------------------------------------------
// reconcile(subject) — the dirty-set sweep (default) + resumable full-sweep
// ---------------------------------------------------------------------------------------------

/** Options for {@link reconcile}. */
export interface ReconcileOptions {
  /**
   * Sweep mode:
   *   - `"dirty"` (default): visit only contacts with `dirty_since IS NOT NULL` (the cheap,
   *     narrowed per-tick sweep). Bounded by `maxContacts`.
   *   - `"full"`: visit EVERY contact, resuming from the persisted full-sweep cursor; advances the
   *     cursor as it goes so a later tick continues where this one stopped.
   */
  mode?: "dirty" | "full";
  /** Max contacts to process this tick (the per-tick budget / fan-out window). Default 200. */
  maxContacts?: number;
  /** Backoff before resume on a 429 (ms). Default {@link DEFAULT_BACKOFF_MS}. Tests pass 0. */
  backoffMs?: number;
  /** Injectable sleep (tests stub it). */
  sleepFn?: (ms: number) => Promise<void>;
}

/** Result of a {@link reconcile} sweep. */
export interface ReconcileSweepResult {
  mode: "dirty" | "full";
  /** Contacts visited this tick. */
  processed: number;
  /** Contacts whose diff landed clean (dirty cleared). */
  reconciled: number;
  /** Contacts whose Resend topic ids could not all be mapped (fail-loud; surfaced, still dirty). */
  unmapped: ReconcileContactResult[];
  /** True when a 429 paused the sweep mid-tick (it will resume next tick). */
  rateLimited: boolean;
  /** For a full sweep: the cursor (last contact id processed) to resume from next tick; null when
   *  the full sweep reached the end and the cursor was reset. Undefined for a dirty sweep. */
  resumeCursor?: string | null;
}

interface DirtyContactRow {
  id: number | string;
  email: string;
}

/**
 * The reconcile sweep — the broadcast lane's pre-send consistency pass (R29). Runs as the LAST step
 * before `broadcasts.create` (see U15's `runIssue` ordering). Two modes:
 *
 *   - DIRTY (default): processes the dirty-set (`sdk_contacts.dirty_since IS NOT NULL`) up to the
 *     per-tick budget. This is the cheap, narrowed path the broadcast loop calls each issue.
 *   - FULL: a periodic safety net that walks EVERY contact, resumable across ticks via a persisted
 *     cursor (`sdk_program_state` under `__envoy_reconcile_sweep__`). A tick that exhausts its
 *     budget persists the last id; the next FULL tick resumes after it. When the walk reaches the
 *     end, the cursor resets to null (the next full sweep starts over).
 *
 * Per-contact fail-soft: one contact's Resend error never aborts the sweep — it leaves that contact
 * dirty and moves on. A 429 pauses the sweep for the rest of THIS tick (so we don't hammer a
 * rate-limited account) and resumes next tick; the paused contact stays dirty.
 */
export async function reconcile(
  envoy: Envoy,
  options: ReconcileOptions = {}
): Promise<ReconcileSweepResult> {
  const mode = options.mode ?? "dirty";
  const maxContacts = options.maxContacts ?? 200;
  const backoffMs = options.backoffMs ?? DEFAULT_BACKOFF_MS;
  // sleepFn is threaded straight to reconcileContact (via options.sleepFn) where the per-contact
  // 429 backoff actually sleeps; the sweep itself never sleeps, so no local binding here.

  const topicCache = await loadTopicCache(envoy);

  const result: ReconcileSweepResult = {
    mode,
    processed: 0,
    reconciled: 0,
    unmapped: [],
    rateLimited: false,
  };

  const startCursor = mode === "full" ? await readSweepCursor(envoy) : null;
  const contacts =
    mode === "full"
      ? await readContactPage(envoy, startCursor, maxContacts)
      : await readDirtyContacts(envoy, maxContacts);

  // The full-sweep resume cursor advances ONLY past contacts that fully reconciled this tick. A
  // contact that did NOT fully reconcile (a 429 that breaks the tick, or a per-contact error) must
  // stay revisitable: if we advanced `lastId` onto it and the tick then ended, the persisted cursor
  // would point PAST that contact and the next full cycle would skip it for the whole sweep — a
  // PAUSED/errored contact silently dropped from the cycle. So we leave `lastId` at the PREVIOUS
  // (last fully-reconciled) contact when a contact does not fully reconcile.
  let lastId: string | null = startCursor;

  for (const row of contacts) {
    const r = await reconcileContact(envoy, {
      email: row.email,
      topicCache,
      backoffMs,
      sleepFn: options.sleepFn,
    });
    result.processed += 1;

    if (r.outcome === "rate_limited") {
      // Pause the rest of this tick — resume next tick. The contact stays dirty and the resume
      // cursor is NOT advanced onto it (do not skip the un-reconciled contact next cycle).
      result.rateLimited = true;
      break;
    }
    if (r.outcome === "error") {
      // A per-contact error: keep sweeping the rest of the tick, but do NOT advance the resume
      // cursor onto this contact (leave it revisitable next full cycle). Move to the next contact.
      continue;
    }

    // The contact was fully handled this tick (reconciled, or unmapped-and-surfaced) — it is safe to
    // advance the resume cursor past it.
    lastId = String(row.id);
    if (r.outcome === "reconciled") result.reconciled += 1;
    if (r.outcome === "unmapped") result.unmapped.push(r);
  }

  if (mode === "full") {
    // If we processed a full budget-worth, there may be more — persist the resume cursor. If we got
    // fewer than the budget (reached the end), reset to null so the next full sweep starts over.
    const reachedEnd = contacts.length < maxContacts && !result.rateLimited;
    const nextCursor = reachedEnd ? null : lastId;
    await writeSweepCursor(envoy, nextCursor);
    result.resumeCursor = nextCursor;
  }

  return result;
}

/** Read up to `limit` dirty contacts (`dirty_since IS NOT NULL`), oldest-dirty first (so the most
 * stale drift is repaired first). Returns bare emails. */
async function readDirtyContacts(
  envoy: Envoy,
  limit: number
): Promise<DirtyContactRow[]> {
  const res = await envoy.db.query<DirtyContactRow>(
    `SELECT id, email FROM sdk_contacts
       WHERE namespace = $1 AND dirty_since IS NOT NULL
       ORDER BY dirty_since ASC, id ASC
       LIMIT $2`,
    [envoy.db.namespace, limit]
  );
  return res.rows;
}

/** Read up to `limit` contacts with `id > cursor` (or from the start when cursor is null), ordered
 * by id — the resumable full-sweep page. */
async function readContactPage(
  envoy: Envoy,
  cursor: string | null,
  limit: number
): Promise<DirtyContactRow[]> {
  if (cursor === null) {
    const res = await envoy.db.query<DirtyContactRow>(
      `SELECT id, email FROM sdk_contacts
         WHERE namespace = $1
         ORDER BY id ASC
         LIMIT $2`,
      [envoy.db.namespace, limit]
    );
    return res.rows;
  }
  const res = await envoy.db.query<DirtyContactRow>(
    `SELECT id, email FROM sdk_contacts
       WHERE namespace = $1 AND id > $2
       ORDER BY id ASC
       LIMIT $3`,
    [envoy.db.namespace, cursor, limit]
  );
  return res.rows;
}

/** Read the persisted full-sweep resume cursor (the last contact id processed), or null when the
 * full sweep has never run / reached the end. Stored in `sdk_program_state.watermark`. */
async function readSweepCursor(envoy: Envoy): Promise<string | null> {
  const res = await envoy.db.query<{ watermark: string | null }>(
    `SELECT watermark FROM sdk_program_state
       WHERE namespace = $1 AND program_key = $2 AND subject_key = $3`,
    [envoy.db.namespace, SWEEP_CURSOR_PROGRAM_KEY, SWEEP_CURSOR_SUBJECT_KEY]
  );
  const stored = res.rows[0]?.watermark;
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

/** Persist the full-sweep resume cursor (upsert). A null cursor resets the sweep to the top. */
async function writeSweepCursor(envoy: Envoy, cursor: string | null): Promise<void> {
  await envoy.db.execWrite(
    `INSERT INTO sdk_program_state (namespace, program_key, subject_key, watermark, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (namespace, program_key, subject_key) DO UPDATE
       SET watermark = EXCLUDED.watermark, updated_at = NOW()
     RETURNING namespace`,
    [envoy.db.namespace, SWEEP_CURSOR_PROGRAM_KEY, SWEEP_CURSOR_SUBJECT_KEY, cursor]
  );
}
