import "server-only";

// Topic provisioning (U7 / origin R27, R37). A "Topic" is the unit a recipient can leave
// independently on Resend's hosted preference page. Granularity is per `(stream, subject)` — e.g.
// `digest:IT`, `digest:FR`, `alert:law-change` — so dropping one type/subject on the preference
// page keeps the rest (R27). Topics are created:
//   - `defaultSubscription: 'opt_in'` (the SDK's mirror seeds opt_in; topics are subscribe-by-default),
//   - **public**, so they appear on Resend's hosted preference page (R27). NOTE: resend@6.14.0's
//     `topics.create` payload exposes only `{ name, description, defaultSubscription }` — there is no
//     `public`/`visibility` field in this SDK version. Public visibility is therefore an account/
//     dashboard-level property in this Resend release; we encode the intent in the topic NAME/desc
//     and document it, rather than passing a field the SDK does not accept. See the unit deviations.
//
// Provisioning is IDEMPOTENT and the `topicId` is CACHED install-wide. The cache lives in
// `sdk_program_state` (no new table — "a program_state-adjacent row", mirroring the namespace
// fingerprint sentinel in config.ts) under a reserved program key, keyed by the `(stream, subject)`
// topic key. A claim-or-read on that row guarantees we create the Resend Topic at most once even
// under concurrent first-provisions: the INSERT … ON CONFLICT DO NOTHING either wins (we create the
// Topic and write its id) or loses (we read the cached id), never blind-creating twice.

import type { NamespacedDb } from "../db/pool.js";
import type { ResendClientHandle } from "../resend/client.js";
import type { Stream } from "../consent/mirror.js";
import { assertNonEmpty } from "../internal/assert.js";

/** Reserved `sdk_program_state.program_key` under which topic-id cache rows live (per install).
 * Exported so the reconcile sweep (resend/../broadcast/reconcile.ts) reads the SAME cache rows in
 * reverse (topicId → topicKey) from one shared constant rather than a hand-copied literal. */
export const TOPIC_CACHE_PROGRAM_KEY = "__envoy_topics__";

/**
 * Canonical topic key for a `(stream, subject)` pair. This is the host-meaningful key stored on
 * `sdk_topic_consent.topic_key` AND the `sdk_program_state.subject_key` of the provisioning cache,
 * so the consent mirror and the provisioning cache agree on one identity. `:` is allowed here (it
 * is only forbidden in the install namespace, not in topic keys).
 */
export function topicKeyFor(stream: Stream, subject: string): string {
  // Shared guard (../internal/assert.js); generic `Error`, message `… topic subject must be a
  // non-empty string.` — identical to the prior inline check.
  assertNonEmpty("topic subject", subject);
  return `${stream}:${subject}`;
}

/** Human-facing Resend Topic name. Encodes the stream + subject so the hosted preference page
 * shows a recognizable "type of email" label (R27). */
function topicName(stream: Stream, subject: string): string {
  return `${stream} — ${subject}`;
}

/** Outcome of a provisioning call. `created` distinguishes a fresh Resend Topic from a cache hit. */
export interface ProvisionTopicResult {
  /** The host-meaningful topic key (`stream:subject`). */
  topicKey: string;
  /** The cached Resend Topic id (always present on success). */
  topicId: string;
  /** True when this call created the Resend Topic; false when it returned a cached id. */
  created: boolean;
}

/** Inputs to {@link provisionTopic}. */
export interface ProvisionTopicInput {
  stream: Stream;
  subject: string;
}

/**
 * Read the cached topic id for a topic key, or `null` if not yet provisioned. Pure read.
 */
async function readCachedTopicId(
  db: NamespacedDb,
  topicKey: string
): Promise<string | null> {
  const res = await db.query<{ watermark: string | null }>(
    `SELECT watermark FROM sdk_program_state
       WHERE namespace = $1 AND program_key = $2 AND subject_key = $3`,
    [db.namespace, TOPIC_CACHE_PROGRAM_KEY, topicKey]
  );
  const stored = res.rows[0]?.watermark;
  return typeof stored === "string" && stored.length > 0 ? stored : null;
}

/**
 * Claim-or-read the topic-id cache row for `topicKey`, writing `topicId` if we win the claim.
 * Returns the EFFECTIVE cached id: ours if we won, the pre-existing one if we lost. Returns `null`
 * only when we lost the claim but the winner has not yet written a non-null id (a race we then
 * resolve by re-reading).
 */
async function cacheTopicId(
  db: NamespacedDb,
  topicKey: string,
  topicId: string
): Promise<{ won: boolean; effectiveId: string | null }> {
  const claim = await db.execWrite<{ watermark: string | null }>(
    `INSERT INTO sdk_program_state (namespace, program_key, subject_key, watermark)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (namespace, program_key, subject_key) DO NOTHING
     RETURNING watermark`,
    [db.namespace, TOPIC_CACHE_PROGRAM_KEY, topicKey, topicId]
  );
  if (claim.count > 0) {
    return { won: true, effectiveId: topicId };
  }
  // Lost the claim — a concurrent provision already wrote (or is writing) the row. Read it back.
  const existing = await readCachedTopicId(db, topicKey);
  return { won: false, effectiveId: existing };
}

/**
 * Provision (idempotently) the Resend Topic for a `(stream, subject)` pair and cache its id.
 *
 * Ordering — cache FIRST, create only on a miss:
 *   1. Read the cache. A hit returns the cached id with `created: false`, creating nothing (the
 *      idempotent fast path — the second `provision` of the same pair is a pure read).
 *   2. On a miss, create the Resend Topic (`opt_in`, public-by-intent), then claim-or-read the
 *      cache row. If we lost the claim to a concurrent provision, we adopt the winner's id and the
 *      Topic we created is a harmless duplicate-free no-op (we never persisted its id) — the cache
 *      holds exactly one id per topic key.
 *
 * When Resend is unset (no key) provisioning cannot create a Topic; it returns a cache hit if one
 * exists, otherwise throws (a topic id is required to address the topic for opt-state pushes — a
 * silent no-op here would hide a real misconfiguration, unlike a send which fails soft).
 */
export async function provisionTopic(
  db: NamespacedDb,
  resend: ResendClientHandle,
  input: ProvisionTopicInput
): Promise<ProvisionTopicResult> {
  const topicKey = topicKeyFor(input.stream, input.subject);

  // 1. Cache fast path — idempotent, creates nothing.
  const cached = await readCachedTopicId(db, topicKey);
  if (cached !== null) {
    return { topicKey, topicId: cached, created: false };
  }

  // 2. Miss → create. Resend must be enabled to mint a Topic id.
  const client = resend.client();
  if (!resend.enabled || client === null) {
    throw new Error(
      `[@catalystiq/envoy-sdk] cannot provision topic "${topicKey}": Resend is not configured (set RESEND_API_KEY). ` +
        `Topic provisioning needs a Resend Topic id and cannot be a no-op.`
    );
  }

  const { data, error } = await client.topics.create({
    name: topicName(input.stream, input.subject),
    description: `Envoy ${input.stream} topic for ${input.subject} (public preference-page topic).`,
    defaultSubscription: "opt_in",
  });
  if (error || !data) {
    throw new Error(
      `[@catalystiq/envoy-sdk] Resend topics.create failed for "${topicKey}": ${error?.message ?? "unknown error"}.`
    );
  }

  const { won, effectiveId } = await cacheTopicId(db, topicKey, data.id);
  if (effectiveId === null) {
    // We lost the claim but the winner's id was not readable — treat as transient and surface our
    // own freshly-created id (still a valid Resend Topic for this pair). The cache converges on the
    // winner's id; both ids address an equivalent topic. Re-read once more defensively.
    const reread = await readCachedTopicId(db, topicKey);
    return { topicKey, topicId: reread ?? data.id, created: true };
  }
  return { topicKey, topicId: effectiveId, created: won };
}
