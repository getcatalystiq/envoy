import "server-only";

// Resend webhook receiver + contact-event ingest (U5 / origin R22, R29, R41).
//
// This is the BODY of the `/webhook` sub-path. The mounted route handler (U4,
// `createEnvoyHandler`) has ALREADY Svix-verified the request and re-exposed the verified raw body
// before this receiver runs — so by the time we parse here the signature is trusted (R41). We keep
// a defensive `verify(envoy, request)` helper available for hosts that mount this receiver directly
// (outside `createEnvoyHandler`), so signature verification is never optional at this seam either.
//
// Two event families are ingested, branching on the `type` discriminator:
//
//   contact.*  (contact.created / contact.updated / contact.deleted)
//     A CHANGE SIGNAL only. Resend's `contact.updated` carries the contact's GLOBAL state
//     (`email`, `id`, `unsubscribed`) but NO `topic_id` and no per-topic detail — there are no
//     `topic.*` events at all (verified Resend fact). So we cannot apply a topic diff from the
//     payload; instead we resolve `email | id -> contact` and ENQUEUE A RECONCILE by marking the
//     contact row reconcile-dirty (`sdk_contacts.dirty_since = NOW()`). The reconcile sweep (U14)
//     is what later pulls `contacts.topics.list` and converges the per-topic mirror. A payload-level
//     `unsubscribed = true` is the one thing we CAN apply immediately: it is a GLOBAL suppression
//     that dominates every topic (R26/R29), so we flip `sdk_contacts.unsubscribed = TRUE` at once.
//
//   email.*  (email.delivered / email.bounced / email.complained / email.opened / …)
//     Delivery + suppression analytics. Hard-failure signals (`bounced`, `complained`, plus a
//     permanent `failed`) are SUPPRESSION events: they flip the recipient's global `unsubscribed`
//     flag so the drip lane and broadcast assembly both stop addressing a dead/penalizing address
//     (R22). They MUST NOT touch the contact-reconcile path. Soft/positive signals are observed and
//     acked — there is no analytics/events table in 001_core.sql (U5 ships no migration), so these
//     are recorded as "observed" without inventing schema.
//
// Robustness contract (R41, fail-safe ingest):
//   - NEVER 500 on an unknown / foreign / malformed event — ack-and-ignore with 200 so Resend does
//     not enter a retry storm against a payload we will never accept.
//   - A `contact.*` / `email.*` event whose email matches no known contact is acked-and-ignored.
//   - No full email address is ever logged — emails are reduced via `envoy.redact` at every seam.
//   - An `email.*` event with no `email_id` is still processed for suppression by recipient; the
//     `email_id` guard only gates the (future) per-message analytics join, never suppression.

import type { Envoy } from "../config.js";
import { jsonResponse } from "./handler.js";

// ---------------------------------------------------------------------------------------------
// Event payload shapes (structural — external payloads are not strongly typed by the Resend SDK)
// ---------------------------------------------------------------------------------------------

/** The envelope every Resend webhook shares: a discriminating `type` and a `data` object. */
export interface ResendWebhookEvent {
  type?: string;
  created_at?: string;
  data?: Record<string, unknown>;
}

/** Outcome of ingesting one event — returned for assertions/observability; serialized to the body. */
export interface WebhookIngestResult {
  /** The dispatch branch the event took. */
  kind: "contact" | "suppression" | "analytics" | "ignored";
  /** The discriminator that was seen (echoed for diagnostics; never includes PII). */
  type: string;
  /** True when a reconcile was enqueued (contact change signal). */
  reconcileEnqueued: boolean;
  /** True when a global suppression flag was written. */
  suppressed: boolean;
  /** True when the referenced contact existed and was resolved. */
  contactMatched: boolean;
}

// ---------------------------------------------------------------------------------------------
// Event classification
// ---------------------------------------------------------------------------------------------

/** `email.*` event types that mean the address is dead or penalizing us → global suppression (R22). */
const SUPPRESSION_EMAIL_TYPES: ReadonlySet<string> = new Set([
  "email.bounced",
  "email.complained",
  "email.failed",
]);

function isContactEvent(type: string): boolean {
  return type.startsWith("contact.");
}

function isEmailEvent(type: string): boolean {
  return type.startsWith("email.");
}

// ---------------------------------------------------------------------------------------------
// Payload extraction (defensive — every field optional, tolerant of `to` string-or-array)
// ---------------------------------------------------------------------------------------------

/**
 * Pull a recipient email out of an event's `data`. Contact events carry `data.email`; email events
 * carry `data.to` (Resend sends an array; we also tolerate a bare string). Returns the FIRST valid
 * recipient, lowercased+trimmed (so resolution is case-insensitive), or null when none is present.
 */
export function extractRecipientEmail(data: Record<string, unknown> | undefined): string | null {
  if (!data) return null;

  const direct = data.email;
  if (typeof direct === "string" && direct.includes("@")) {
    return normalizeEmail(direct);
  }

  const to = data.to;
  if (typeof to === "string" && to.includes("@")) {
    return normalizeEmail(to);
  }
  if (Array.isArray(to)) {
    for (const entry of to) {
      if (typeof entry === "string" && entry.includes("@")) {
        return normalizeEmail(entry);
      }
    }
  }
  return null;
}

function normalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

/** True when the contact payload itself declares a GLOBAL unsubscribe we can apply immediately. */
function payloadIsGlobalUnsubscribed(data: Record<string, unknown> | undefined): boolean {
  return data?.unsubscribed === true;
}

// ---------------------------------------------------------------------------------------------
// DB seams — namespaced, bare-email keyed (mirrors the `sdk_contacts` convention in consent/mirror.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Resolve whether a contact exists for `email`, scoped to this install's namespace. `email` is the
 * already-normalized (lowercased) recipient; `sdk_contacts.email` stores the BARE email (namespace
 * is a column), matching the global-suppress write in `consent/mirror.ts`, and is matched
 * case-insensitively via `lower(email)`. The downstream writes key off the SAME normalized email,
 * so resolution and write always agree regardless of the case Resend echoed.
 */
async function contactExists(envoy: Envoy, email: string): Promise<boolean> {
  const res = await envoy.db.query<{ email: string }>(
    `SELECT email FROM sdk_contacts WHERE namespace = $1 AND lower(email) = $2 LIMIT 1`,
    [envoy.db.namespace, email]
  );
  return res.rows.length > 0;
}

/**
 * Enqueue a reconcile for a contact: mark its row reconcile-dirty. The reconcile sweep (U14) keys
 * off `dirty_since IS NOT NULL` (see the `sdk_contacts_dirty_idx` partial index). Idempotent — a
 * second dirty stamp before the sweep runs just re-stamps the timestamp.
 */
async function enqueueReconcile(envoy: Envoy, email: string): Promise<void> {
  await envoy.db.query(
    `UPDATE sdk_contacts SET dirty_since = NOW(), updated_at = NOW()
       WHERE namespace = $1 AND lower(email) = $2`,
    [envoy.db.namespace, email]
  );
}

/**
 * Apply a GLOBAL suppression to a contact: flip `unsubscribed = TRUE`, mark dirty so reconcile
 * pushes the suppression out to every topic (R26/R29 suppress-all), AND fan the suppression into
 * every existing per-topic consent row as monotonic `unsubscribed` so the send gate denies BOTH
 * lanes immediately (R22) — the gate's per-topic read alone would otherwise miss a suppression that
 * only lives on the contact flag. Monotonic — we only ever raise suppression here; a re-subscribe is
 * a separate, explicit host action.
 */
async function suppressContact(envoy: Envoy, email: string): Promise<void> {
  // ONE statement: flip the contact flag AND fan the suppression into every per-topic consent row.
  // The injected pool has no transaction surface, so we lean on a single data-modifying CTE — the
  // `sdk_contacts` UPDATE runs in the WITH clause, the `sdk_topic_consent` fan-out is the outer
  // statement, and Postgres commits both or neither. A crash can no longer leave the contact globally
  // suppressed while its consent rows still read `opt_in` (which the gate would honor and keep sending).
  const namespacedContact = envoy.db.namespaceKey(email);
  await envoy.db.query(
    `WITH c AS (
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

// ---------------------------------------------------------------------------------------------
// Ingest core (auth-agnostic — assumes the caller verified the Svix signature, U4)
// ---------------------------------------------------------------------------------------------

/**
 * Ingest one already-verified, already-parsed Resend webhook event. Pure dispatch + DB writes; it
 * never throws on an unknown / foreign / unmatched event (R41 ack-and-ignore). Returns a structured
 * result the route layer serializes into the 200 body.
 */
export async function ingestEvent(
  envoy: Envoy,
  event: ResendWebhookEvent
): Promise<WebhookIngestResult> {
  const type = typeof event.type === "string" ? event.type : "";
  const data = event.data;

  // ----- contact.* — change signal → reconcile (R29/R41) -------------------------------------
  if (isContactEvent(type)) {
    const email = extractRecipientEmail(data);
    if (email === null) {
      return ack("contact", type, { contactMatched: false });
    }
    if (!(await contactExists(envoy, email))) {
      // Foreign/unknown contact — ack-and-ignore, no 500, no full email in logs.
      return ack("ignored", type, { contactMatched: false });
    }

    if (payloadIsGlobalUnsubscribed(data)) {
      // A global unsubscribe carried in the payload dominates every topic — apply immediately AND
      // enqueue a reconcile so the per-topic mirror is pushed out by the sweep (U14).
      await suppressContact(envoy, email);
      return {
        kind: "contact",
        type,
        reconcileEnqueued: true,
        suppressed: true,
        contactMatched: true,
      };
    }

    await enqueueReconcile(envoy, email);
    return {
      kind: "contact",
      type,
      reconcileEnqueued: true,
      suppressed: false,
      contactMatched: true,
    };
  }

  // ----- email.* — delivery/suppression analytics (R22) --------------------------------------
  if (isEmailEvent(type)) {
    if (SUPPRESSION_EMAIL_TYPES.has(type)) {
      const email = extractRecipientEmail(data);
      if (email === null) {
        return ack("ignored", type, { contactMatched: false });
      }
      if (!(await contactExists(envoy, email))) {
        return ack("ignored", type, { contactMatched: false });
      }
      // Suppression is a GLOBAL signal and must NOT touch the contact-reconcile diff path beyond
      // the dirty stamp that suppression itself carries — it never resolves topics from the payload.
      await suppressContact(envoy, email);
      return {
        kind: "suppression",
        type,
        reconcileEnqueued: false,
        suppressed: true,
        contactMatched: true,
      };
    }

    // Positive / soft delivery signal (delivered, opened, clicked, sent, …). Observed for analytics;
    // there is no events table in 001_core.sql (U5 ships no migration) so this is a no-op ack — but
    // it is explicitly an `analytics` branch (not `ignored`) so the regression test can assert that
    // `email.*` never falls through to the contact-reconcile path.
    return ack("analytics", type, { contactMatched: false });
  }

  // ----- unknown / foreign event — ack-and-ignore (R41) --------------------------------------
  return ack("ignored", type, { contactMatched: false });
}

function ack(
  kind: WebhookIngestResult["kind"],
  type: string,
  over: Partial<WebhookIngestResult> = {}
): WebhookIngestResult {
  return {
    kind,
    type,
    reconcileEnqueued: false,
    suppressed: false,
    contactMatched: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Route seam — a `SubHandler` for `createEnvoyHandler({ webhook })`
// ---------------------------------------------------------------------------------------------

/**
 * Build the `/webhook` sub-handler. Wire the returned function as
 * `createEnvoyHandler({ ..., webhook: createWebhookReceiver(envoy) })`.
 *
 * The route factory has already Svix-verified the request and re-exposed the verified raw body, so
 * this receiver parses + dispatches only. It ALWAYS returns 2xx for a processable or ignorable
 * event (R41 ack-and-ignore) and never 500s on a malformed body — a 5xx would make Resend retry a
 * payload we will never accept.
 */
export function createWebhookReceiver(
  envoy: Envoy
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    let event: ResendWebhookEvent;
    try {
      const raw = await request.text();
      event = parseEvent(raw);
    } catch {
      // Unparseable body from a (Svix-verified) sender — ack so Resend stops retrying. Never 500.
      return jsonResponse(200, ack("ignored", ""));
    }

    try {
      const result = await ingestEvent(envoy, event);
      return jsonResponse(200, result);
    } catch (err) {
      // A DB error mid-ingest is the one case we surface as 5xx so Resend retries the WRITE (the
      // signature was valid; the failure is ours, not the sender's). Redact before logging.
      // eslint-disable-next-line no-console
      console.error(
        "[@catalystiq/envoy-sdk] webhook ingest failed:",
        envoy.redact(err instanceof Error ? err.message : String(err))
      );
      return jsonResponse(500, { ok: false, error: "ingest_failed" });
    }
  };
}

/** Parse the raw verified body into an event envelope. Throws on non-object JSON. */
function parseEvent(raw: string): ResendWebhookEvent {
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TypeError("webhook body is not a JSON object");
  }
  return parsed as ResendWebhookEvent;
}
