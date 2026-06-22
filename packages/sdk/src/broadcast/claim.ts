import "server-only";

// Broadcast send-once claim + crash-safe resume (U11 / origin R30, KTD10).
//
// resend@6.14.0 exposes NO idempotency key on `broadcasts.create`/`broadcasts.send`
// (idempotencyKey is scoped to `emails.send`/`emails.batch` only — verified against the
// shipped type defs). So a broadcast cannot lean on Resend to absorb a blind replay. The
// send-once guard is therefore an EXTERNAL atomic claim row keyed on a host-supplied
// `broadcastKey` (`sdk_broadcast_claims`, PK `(namespace, broadcast_key)`):
//
//   1. CLAIM — `INSERT … ON CONFLICT DO NOTHING RETURNING`. Proceed only on a won claim.
//      A concurrent second tick on the same key loses the INSERT (0 returned rows) and MUST
//      NOT send. This is the concurrency guard for overlapping ticks — a fixed contract, not
//      a deferred decision (R30). Success is derived from `rows.length`, never a driver
//      `rowCount` (Neon's HTTP driver does not populate `rowCount`; see pool.ts invariant 1).
//
//   2. PERSIST — immediately after `broadcasts.create` returns, persist the Resend broadcast
//      id into the claim row. The common resume path then reads that id DIRECTLY and never
//      scans Resend.
//
//   3. RESUME — a pre-existing claim with `sent_at IS NULL` is a resumable PRIOR attempt, not a
//      duplicate. If its `resend_broadcast_id` is present, resume reads it and continues. Only
//      when the id is ABSENT (a crash in the persist gap, after Resend accepted but before the
//      id landed) does resume precheck `broadcasts.list` for the deterministic `name =
//      broadcastKey` before re-creating — there is no idempotency key to absorb a blind replay,
//      and `name` carries no server-side uniqueness, so the LIST precheck (not the name) is the
//      dedup. `ListBroadcastsOptions` has NO name filter and the list payload is
//      `id|name|status|created_at|…` only, so the precheck pages (cursor-based) and filters
//      client-side, bounded by `created_at >= claim.created_at`, with an explicit max-pages
//      budget and a short retry for replication lag. On budget exhaustion it FAILS LOUD
//      (operator confirmation required), never blind-re-creates (a blind re-create is a
//      double-blast — the exact failure R30 forbids).
//
// Patterns reimplemented (never imported, per R48): `045_session_resume.sql` claim/resume
// marker shape, `claimQueuedEmails` (lib/queries/system.ts) claim-on-conflict idiom, and the
// CAS-gate + Neon `rows.length` learning (docs/solutions/2026-06-19-crm-lifecycle-sync-cas-gate.md).

import type { NamespacedDb } from "../db/pool.js";
import type { ResendClientHandle } from "../resend/client.js";

/** Table backing the external send-once guard (see migrations/001_core.sql). */
const CLAIMS_TABLE = "sdk_broadcast_claims";

/** Default ceiling on `broadcasts.list` pages walked during a crash-resume precheck. A real host
 * persists the id on the common path, so the precheck only runs after a crash in the narrow
 * persist gap; this budget bounds the cost AND is the fail-loud tripwire that prevents a
 * blind re-create at high volume. */
export const DEFAULT_PRECHECK_MAX_PAGES = 20;

/** Per-page size for the `broadcasts.list` precheck (Resend allows 1–100; default 20). */
export const DEFAULT_PRECHECK_PAGE_SIZE = 100;

/** Default number of extra precheck attempts after an empty/no-match first pass, to absorb
 * read-replica lag between `broadcasts.create` accepting and the new broadcast becoming
 * listable. Each retry waits `retryDelayMs`. */
export const DEFAULT_PRECHECK_RETRIES = 2;

/** Default delay (ms) between precheck retries. Small — replication lag, not a backoff. */
export const DEFAULT_PRECHECK_RETRY_DELAY_MS = 250;

/**
 * A broadcast claim row as stored. Times are ISO strings (Postgres TIMESTAMPTZ); the bare
 * `broadcast_key` is the host key (namespace stripping is the caller's concern via the db wrapper).
 */
export interface BroadcastClaimRow {
  /** Host-supplied broadcast key (bare; one per broadcast issue). */
  broadcastKey: string;
  /** The Resend broadcast id, once `broadcasts.create` returned and it was persisted. Null in the
   *  crash gap between accept and persist. */
  resendBroadcastId: string | null;
  /** Host content item ids included in this issue (provenance / cursor advance). */
  itemIds: string[];
  /** When the broadcast was marked sent. Null ⇒ unsent ⇒ resumable. */
  sentAt: string | null;
  /** When the claim row was created (the `broadcasts.list` precheck lower bound). */
  createdAt: string;
}

/** Outcome of {@link claim}. */
export interface ClaimResult {
  /** True when THIS caller won a fresh claim (the INSERT landed a row). Only a winner may send. */
  won: boolean;
  /** True when the (pre-existing) claim is a resumable prior attempt — `won === false` and the
   *  existing row has `sent_at IS NULL`. A loser that is not resumable already sent (sent_at set)
   *  and must do nothing. */
  resumable: boolean;
  /** The claim row (the freshly-inserted one on a win, the pre-existing one on a loss). Always
   *  present after a claim — the INSERT … RETURNING wins return the new row; a loss reads the row
   *  back (it must exist: the conflict implies a row). */
  row: BroadcastClaimRow;
}

/** A Resend broadcasts-list entry, narrowed to the fields R30's precheck needs. Mirrors
 *  `Pick<Broadcast, 'id'|'name'|'status'|'created_at'|…>` from resend@6.14.0's
 *  `ListBroadcastsResponseSuccess.data`. */
interface ListedBroadcast {
  id: string;
  name: string;
  created_at: string;
}

/** Minimal structural shape of the Resend client surface this module touches. We depend on
 *  `broadcasts.list` only (cursor pagination via `after`), so an injected fake in tests need
 *  not stub the full SDK. */
interface BroadcastsListClient {
  broadcasts: {
    list(options?: {
      limit?: number;
      after?: string;
    }): Promise<{
      data: {
        data: Array<{ id: string; name: string; created_at: string }>;
        has_more: boolean;
      } | null;
      error: { message: string } | null;
    }>;
  };
}

function rowFromDb(r: {
  broadcast_key: string;
  resend_broadcast_id: string | null;
  item_ids: string[] | null;
  sent_at: string | null;
  created_at: string;
}): BroadcastClaimRow {
  return {
    broadcastKey: r.broadcast_key,
    resendBroadcastId: r.resend_broadcast_id,
    itemIds: r.item_ids ?? [],
    sentAt: r.sent_at,
    createdAt: r.created_at,
  };
}

/**
 * Atomically claim the right to send the broadcast for `broadcastKey`.
 *
 * `INSERT … ON CONFLICT DO NOTHING RETURNING` against `sdk_broadcast_claims`:
 *   - WON (1 returned row): `{ won: true, resumable: false, row }`. The caller proceeds to render
 *     + `broadcasts.create`, then calls {@link persistBroadcastId} and {@link markSent}.
 *   - LOST (0 returned rows): a row already exists. We read it back to classify:
 *       - `sent_at IS NULL`  → `{ won: false, resumable: true, row }`  (a crashed prior attempt — the
 *          caller may resume via {@link resolveResumeBroadcastId}).
 *       - `sent_at` set      → `{ won: false, resumable: false, row }` (already sent — do nothing).
 *
 * Success is read from `rows.length` (the won/lost signal), never `rowCount`.
 *
 * @throws if a lost claim cannot be read back (a row MUST exist after a conflict — its absence is a
 *   torn write or a namespace mismatch, a fail-loud condition, not a silent re-send).
 */
export async function claim(
  db: NamespacedDb,
  broadcastKey: string,
  opts?: { itemIds?: ReadonlyArray<string> }
): Promise<ClaimResult> {
  if (typeof broadcastKey !== "string" || broadcastKey.length === 0) {
    throw new Error("[@envoy/sdk] broadcastKey must be a non-empty string.");
  }
  const storedKey = db.namespaceKey(broadcastKey);
  const itemIds = opts?.itemIds ? Array.from(opts.itemIds) : [];

  const inserted = await db.execWrite<{
    broadcast_key: string;
    resend_broadcast_id: string | null;
    item_ids: string[] | null;
    sent_at: string | null;
    created_at: string;
  }>(
    `INSERT INTO ${CLAIMS_TABLE} (namespace, broadcast_key, item_ids)
     VALUES ($1, $2, $3)
     ON CONFLICT (namespace, broadcast_key) DO NOTHING
     RETURNING broadcast_key, resend_broadcast_id, item_ids, sent_at, created_at`,
    [db.namespace, storedKey, itemIds]
  );

  if (inserted.count > 0) {
    const row = rowFromDb(inserted.rows[0]!);
    // Return the bare key the caller passed (strip the namespace the INSERT stored).
    row.broadcastKey = broadcastKey;
    return { won: true, resumable: false, row };
  }

  // Lost the claim — a row exists for this key. Read it to classify resumable vs already-sent.
  const existing = await db.query<{
    broadcast_key: string;
    resend_broadcast_id: string | null;
    item_ids: string[] | null;
    sent_at: string | null;
    created_at: string;
  }>(
    `SELECT broadcast_key, resend_broadcast_id, item_ids, sent_at, created_at
       FROM ${CLAIMS_TABLE}
      WHERE namespace = $1 AND broadcast_key = $2`,
    [db.namespace, storedKey]
  );
  const found = existing.rows[0];
  if (!found) {
    throw new Error(
      `[@envoy/sdk] broadcast claim for "${broadcastKey}" conflicted on INSERT but could not be ` +
        `read back — refusing to send (fail loud, R30/R38).`
    );
  }
  const row = rowFromDb(found);
  row.broadcastKey = broadcastKey;
  return { won: false, resumable: row.sentAt === null, row };
}

/**
 * Persist the Resend broadcast id into the claim row, immediately after `broadcasts.create`
 * returns. This is what lets the COMMON resume path read the id directly and never scan Resend.
 * Idempotent: re-persisting the same id is a no-op-shaped UPDATE. Returns the updated row.
 *
 * @throws if no claim row exists for the key (persisting an id without a held claim is a contract
 *   violation — the caller must `claim()` first).
 */
export async function persistBroadcastId(
  db: NamespacedDb,
  broadcastKey: string,
  resendBroadcastId: string
): Promise<BroadcastClaimRow> {
  if (typeof resendBroadcastId !== "string" || resendBroadcastId.length === 0) {
    throw new Error("[@envoy/sdk] resendBroadcastId must be a non-empty string.");
  }
  const storedKey = db.namespaceKey(broadcastKey);
  const res = await db.execWrite<{
    broadcast_key: string;
    resend_broadcast_id: string | null;
    item_ids: string[] | null;
    sent_at: string | null;
    created_at: string;
  }>(
    `UPDATE ${CLAIMS_TABLE}
        SET resend_broadcast_id = $3
      WHERE namespace = $1 AND broadcast_key = $2
      RETURNING broadcast_key, resend_broadcast_id, item_ids, sent_at, created_at`,
    [db.namespace, storedKey, resendBroadcastId]
  );
  if (res.count === 0) {
    throw new Error(
      `[@envoy/sdk] cannot persist broadcast id for "${broadcastKey}": no claim row (claim first).`
    );
  }
  const row = rowFromDb(res.rows[0]!);
  row.broadcastKey = broadcastKey;
  return row;
}

/**
 * Mark the broadcast sent: set `sent_at = NOW()` and record the included item ids. After this, a
 * future claim for the same key is a non-resumable loss (`sent_at` set ⇒ do nothing). Idempotent on
 * `sent_at` (a second call refreshes the timestamp but the claim is already terminal). Returns the
 * updated row.
 */
export async function markSent(
  db: NamespacedDb,
  broadcastKey: string,
  opts?: { itemIds?: ReadonlyArray<string> }
): Promise<BroadcastClaimRow> {
  const storedKey = db.namespaceKey(broadcastKey);
  const itemIds = opts?.itemIds ? Array.from(opts.itemIds) : null;
  const res = await db.execWrite<{
    broadcast_key: string;
    resend_broadcast_id: string | null;
    item_ids: string[] | null;
    sent_at: string | null;
    created_at: string;
  }>(
    `UPDATE ${CLAIMS_TABLE}
        SET sent_at = NOW(),
            item_ids = COALESCE($3, item_ids)
      WHERE namespace = $1 AND broadcast_key = $2
      RETURNING broadcast_key, resend_broadcast_id, item_ids, sent_at, created_at`,
    [db.namespace, storedKey, itemIds]
  );
  if (res.count === 0) {
    throw new Error(
      `[@envoy/sdk] cannot mark broadcast "${broadcastKey}" sent: no claim row (claim first).`
    );
  }
  const row = rowFromDb(res.rows[0]!);
  row.broadcastKey = broadcastKey;
  return row;
}

/** Knobs for the crash-resume precheck. All have safe defaults; tests override them. */
export interface ResumePrecheckOptions {
  /** Max `broadcasts.list` pages to walk before failing loud. Default {@link DEFAULT_PRECHECK_MAX_PAGES}. */
  maxPages?: number;
  /** Page size for `broadcasts.list`. Default {@link DEFAULT_PRECHECK_PAGE_SIZE}. */
  pageSize?: number;
  /** Extra attempts after a no-match pass (replication lag). Default {@link DEFAULT_PRECHECK_RETRIES}. */
  retries?: number;
  /** Delay (ms) between retries. Default {@link DEFAULT_PRECHECK_RETRY_DELAY_MS}. */
  retryDelayMs?: number;
  /** Injectable sleep (tests pass a no-op). Defaults to a real `setTimeout` promise. */
  sleep?: (ms: number) => Promise<void>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Outcome of {@link resolveResumeBroadcastId}. */
export type ResumeResolution =
  /** The broadcast already exists in Resend (found by name+created_at). Resume reads it; do NOT
   *  re-create. `id` is the existing Resend broadcast id (from the persisted row or the precheck). */
  | { status: "exists"; broadcastId: string; source: "persisted" | "precheck" }
  /** No matching broadcast exists after a bounded, retried precheck — it is SAFE to (re-)create.
   *  This is only returned when the precheck completed within budget and found nothing. */
  | { status: "absent" };

/**
 * Resolve, for a resumable (`sent_at IS NULL`) claim, whether the broadcast already exists in
 * Resend — so the caller can resume rather than blind-re-create (the double-blast R30 forbids).
 *
 * COMMON PATH: the persisted `resend_broadcast_id` is present → `{ status: "exists", source:
 * "persisted" }` with no Resend call at all.
 *
 * CRASH GAP: the id is absent (crash after `broadcasts.create` accepted, before persist) → precheck
 * `broadcasts.list` for the deterministic `name === broadcastKey`. Since the list endpoint has no
 * name filter and no `created_at` filter param, we page (cursor `after`) and filter client-side,
 * stopping a page early once `created_at < claim.createdAt` (results are newest-first; older pages
 * cannot contain our broadcast). We retry the whole walk a few times to absorb read-replica lag.
 *   - A name+created_at match → `{ status: "exists", source: "precheck" }` (resume; never re-create).
 *   - No match within budget   → `{ status: "absent" }` (safe to create).
 *   - Budget (maxPages) exhausted on ANY attempt → THROW (fail loud — operator confirmation; never
 *     blind-re-create at high volume).
 *
 * `name === broadcastKey` is the deterministic name the broadcast lane sets on `broadcasts.create`
 * (U12). It carries no server-side uniqueness — the LIST match, not the name, is the dedup.
 *
 * @throws when the precheck cannot complete within `maxPages` (fail loud), or when Resend is
 *   unset/disabled (a resumable id-absent claim cannot be resolved without listing — surfacing it
 *   beats a blind re-create), or on a Resend list error.
 */
export async function resolveResumeBroadcastId(
  resend: ResendClientHandle,
  claimRow: Pick<BroadcastClaimRow, "broadcastKey" | "resendBroadcastId" | "createdAt">,
  opts?: ResumePrecheckOptions
): Promise<ResumeResolution> {
  // Common path: the id was persisted before the crash (or there was no crash). No Resend call.
  if (claimRow.resendBroadcastId) {
    return { status: "exists", broadcastId: claimRow.resendBroadcastId, source: "persisted" };
  }

  const client = resend.client() as unknown as BroadcastsListClient | null;
  if (!resend.enabled || client === null) {
    throw new Error(
      `[@envoy/sdk] cannot resolve resume for broadcast "${claimRow.broadcastKey}": its Resend id is ` +
        `absent (crash gap) and Resend is not configured to run the broadcasts.list precheck. ` +
        `Refusing to blind re-create (fail loud, R30).`
    );
  }

  const maxPages = opts?.maxPages ?? DEFAULT_PRECHECK_MAX_PAGES;
  const pageSize = opts?.pageSize ?? DEFAULT_PRECHECK_PAGE_SIZE;
  const retries = opts?.retries ?? DEFAULT_PRECHECK_RETRIES;
  const retryDelayMs = opts?.retryDelayMs ?? DEFAULT_PRECHECK_RETRY_DELAY_MS;
  const sleep = opts?.sleep ?? defaultSleep;

  const lowerBoundMs = Date.parse(claimRow.createdAt);
  // A naive guard: if the stored createdAt is unparseable, do not silently widen the window to "all
  // time" — treat as no lower bound but keep the page budget (still bounded by maxPages).
  const hasLowerBound = Number.isFinite(lowerBoundMs);

  // Attempt the full bounded walk; retry it a few times for replication lag.
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const found = await precheckScan(client, claimRow.broadcastKey, {
      maxPages,
      pageSize,
      lowerBoundMs: hasLowerBound ? lowerBoundMs : null,
    });
    if (found) {
      return { status: "exists", broadcastId: found, source: "precheck" };
    }
    if (attempt < retries) {
      await sleep(retryDelayMs);
    }
  }

  return { status: "absent" };
}

/**
 * One bounded pass of `broadcasts.list`, filtering client-side for `name === broadcastKey` and
 * `created_at >= lowerBound`. Returns the matching broadcast id, or `null` if no match was found
 * within the page budget AND the walk reached its natural end (no more pages, or pages fell below
 * the lower bound). THROWS when the page budget is exhausted while more in-window pages remain
 * (fail loud) or on a Resend error.
 */
async function precheckScan(
  client: BroadcastsListClient,
  broadcastKey: string,
  cfg: { maxPages: number; pageSize: number; lowerBoundMs: number | null }
): Promise<string | null> {
  let after: string | undefined;
  for (let page = 0; page < cfg.maxPages; page += 1) {
    const { data, error } = await client.broadcasts.list({
      limit: cfg.pageSize,
      ...(after ? { after } : {}),
    });
    if (error || !data) {
      throw new Error(
        `[@envoy/sdk] broadcasts.list precheck failed for "${broadcastKey}": ` +
          `${error?.message ?? "unknown error"} (fail loud, R30).`
      );
    }

    const entries: ListedBroadcast[] = data.data;
    let belowLowerBound = false;
    for (const b of entries) {
      if (cfg.lowerBoundMs !== null) {
        const createdMs = Date.parse(b.created_at);
        if (Number.isFinite(createdMs) && createdMs < cfg.lowerBoundMs) {
          // Results are newest-first; once below the claim's createdAt, our broadcast cannot be on
          // this entry, any later entry on this page, or any later page. STOP the page scan here —
          // a `continue` would keep checking later (older) same-page entries, and a stale duplicate
          // re-using our deterministic name below the lower bound could then be wrongly returned as
          // a match. Break out so only in-window entries are ever matched.
          belowLowerBound = true;
          break;
        }
      }
      if (b.name === broadcastKey) {
        return b.id;
      }
    }

    if (belowLowerBound || !data.has_more) {
      // Reached the natural end of the in-window range with no match → safe-to-create.
      return null;
    }

    // Advance the cursor to the last entry of this page.
    const last = entries[entries.length - 1];
    if (!last) {
      // Empty page but `has_more` true — defensive: no cursor to advance, treat as end.
      return null;
    }
    after = last.id;
  }

  // Budget exhausted while in-window pages may still remain. FAIL LOUD — do not blind re-create.
  throw new Error(
    `[@envoy/sdk] broadcasts.list precheck for "${broadcastKey}" exhausted its ${cfg.maxPages}-page ` +
      `budget without resolving whether the broadcast exists. Refusing to re-create (a blind replay ` +
      `is a double-send). Operator confirmation required (fail loud, R30).`
  );
}
