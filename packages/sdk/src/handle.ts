import "server-only";

// The method-facade handle (EnvoyClient).
//
// `createEnvoy` (config.ts) builds the BARE handle — config / db / resend / redact. The SDK's
// server functions are standalone (`enroll(envoy, …)`, `sendTransactional(envoy, input, config)`,
// …) so the leaf modules depend only on the `Envoy` TYPE. This module sits ABOVE them and binds the
// bare handle into those functions, exposing the ergonomic method surface the docs use
// (`envoy.enroll(…)`, `envoy.send.transactional(…)`, `envoy.consent.set(…)`, …). It is the only
// module that value-imports both config and the leaves, so there is no import cycle.
//
// The standalone exports remain available for advanced callers; this is additive sugar.

import { createEnvoy as createBaseEnvoy, type Envoy, type EnvoyConfig } from "./config.js";
import { createConsentMirror, type ConsentMirror } from "./consent/mirror.js";
import {
  enroll,
  deleteContact,
  type ContactInput,
  type EnrollOptions,
  type EnrollResult,
  type DeleteContactResult,
} from "./contacts.js";
import {
  sendTransactional,
  type TransactionalSendInput,
  type TransactionalSendResult,
} from "./drip/transactional.js";
import {
  ingestEvent,
  type ResendWebhookEvent,
  type WebhookIngestResult,
} from "./route/webhook.js";
import {
  createEnvoyHandler,
  type EnvoyHandlerConfig,
  type EnvoyRouteHandlers,
} from "./route/handler.js";

/**
 * The Envoy handle with bound method sugar — what `createEnvoy` returns. Extends the bare {@link Envoy}
 * (so it still works anywhere a standalone `fn(envoy, …)` wants a handle) and adds:
 *
 *  - `enroll(contact, sequenceKey, options?)` — drip enrollment (idempotent).
 *  - `send.transactional(input)` — one-shot templated send (uses the handle's consent mirror; the
 *    standard lane also needs `unsubscribeBaseUrl` in config — see {@link EnvoyConfig}).
 *  - `consent` — the consent mirror (`.set` / `.gate` / `.isGloballySuppressed` / `.reconcile`).
 *  - `contacts.delete(email, options?)` — GDPR delete (suppress-first, best-effort).
 *  - `ingest(event)` — ingest an already-Svix-verified Resend webhook event.
 *  - `routeHandler(config)` — build the mounted `{ GET, POST }` route handlers (envoy bound).
 */
export interface EnvoyClient extends Envoy {
  enroll(
    contact: ContactInput,
    sequenceKey: string,
    options?: EnrollOptions,
  ): Promise<EnrollResult>;
  readonly send: {
    transactional(input: TransactionalSendInput): Promise<TransactionalSendResult>;
  };
  readonly consent: ConsentMirror;
  readonly contacts: {
    delete(
      rawEmail: string,
      options?: { segmentIds?: string[]; topicIds?: string[] },
    ): Promise<DeleteContactResult>;
  };
  ingest(event: ResendWebhookEvent): Promise<WebhookIngestResult>;
  routeHandler(config: Omit<EnvoyHandlerConfig, "envoy">): EnvoyRouteHandlers;
}

/**
 * Create the Envoy handle. Returns an {@link EnvoyClient} — the bare handle plus bound method sugar.
 * Single-tenant: one call = one install namespace (R38).
 */
export function createEnvoy(cfg: EnvoyConfig): EnvoyClient {
  const base = createBaseEnvoy(cfg);
  // One consent mirror per handle, reused by `consent` and `send.transactional`.
  const consent = createConsentMirror(base.db, base.resend);

  // Mutate the bare handle in place so its non-enumerable, secret-redacting `toJSON` survives (a
  // spread would drop it). The added methods close over `base`, so a standalone call and the method
  // form are identical.
  Object.assign(base, {
    enroll: (contact: ContactInput, sequenceKey: string, options?: EnrollOptions) =>
      enroll(base, contact, sequenceKey, options),
    send: {
      transactional: (input: TransactionalSendInput) =>
        sendTransactional(base, input, {
          mirror: consent,
          // Empty when unset ⇒ the standard lane fails loud inside sendTransactional ("requires
          // unsubscribeBaseUrl"); the system lane never reads it.
          unsubscribeBaseUrl: base.config.unsubscribeBaseUrl ?? "",
        }),
    },
    consent,
    contacts: {
      delete: (rawEmail: string, options?: { segmentIds?: string[]; topicIds?: string[] }) =>
        deleteContact(base, rawEmail, options),
    },
    ingest: (event: ResendWebhookEvent) => ingestEvent(base, event),
    routeHandler: (config: Omit<EnvoyHandlerConfig, "envoy">) =>
      createEnvoyHandler({ envoy: base, ...config }),
  });

  return base as unknown as EnvoyClient;
}
