import "server-only";

// Transactional send — one-shot, non-AI templated `emails.send` (U10 / origin R45, R46).
//
// This is the clean import for welcome / confirmation / receipt emails whose shape the AI drip
// engine (U8) does not fit. It is DISTINCT from the drip lane: no enrollment, no sequence, no AI
// generation. The host names a saved Resend Template by id, supplies the merge variables, and the
// SDK sends one email through `resend.emails.send`.
//
// Five load-bearing properties, each tied to a requirement:
//
//   1. REQUIRED STREAM (R46/R45). `stream` scopes the `List-Unsubscribe` token (R33) — every
//      transactional email must carry a working, stream-scoped one-click opt-out. A call with no
//      stream is REJECTED at this call boundary (the config-time validation in U18 catches the
//      static cases; U10 still fails loud at runtime so a malformed/omitted unsubscribe can never
//      ship). The unit spec is explicit: "missing-stream rejection is validation in U18; U10
//      enforces it at its call boundary."
//
//   2. MIRROR-GATED (R26/R46). The suppression mirror is consulted FIRST. A suppressed contact
//      (global unsubscribe or a topic-scoped opt_out for this stream) is NOT sent — the call
//      returns `{ sent: false, reason: "suppressed" }` and touches Resend not at all.
//
//   3. RFC 8058 LIST-UNSUBSCRIBE (R33). The drip/transactional lane cannot use Resend's native
//      broadcast unsubscribe (that rides on `broadcasts.create` only). So `emails.send` carries the
//      SDK's own `List-Unsubscribe` + `List-Unsubscribe-Post: List-Unsubscribe=One-Click` headers,
//      pointing at the SDK-owned topic-scoped landing (U6 `buildListUnsubscribeHeaders`).
//
//   4. IDEMPOTENCY AS A REQUEST OPTION (R46). resend@6.14.0's idempotency key is NOT a body field —
//      it is the `Idempotency-Key` HTTP header, surfaced by the SDK as the second arg to
//      `emails.send(payload, { idempotencyKey })` (`CreateEmailRequestOptions extends IdempotentRequest`).
//      Putting it in the body would be silently ignored. We pass it as the request option.
//
//   5. NO-OP WHEN RESEND UNSET (R43). With no API key the Resend client is disabled; the call is a
//      silent no-op (`{ sent: false, reason: "resend_disabled" }`) — mirrors the app mailer and the
//      rest of the SDK's "unset key ⇒ no-op, never throw" contract.

import type { CreateEmailOptions } from "resend";

import type { Envoy } from "../config.js";
import type { ConsentMirror, Stream } from "../consent/mirror.js";
import { buildListUnsubscribeHeaders } from "../consent/unsubscribe.js";

/**
 * Merge variables injected into the Resend Template. resend@6.14.0's `template.variables` is typed
 * `Record<string, string | number>`; we accept the same so the value passes straight through.
 */
export type TransactionalVariables = Record<string, string | number>;

/** Inputs to {@link sendTransactional} (origin R46). */
export interface TransactionalSendInput {
  /** Recipient email (the contact key; namespace-prefixed only at the DB boundary, not on the wire). */
  email: string;

  /** Saved Resend Template id whose variables this send fills (`emails.send({ template: { id } })`). */
  templateId: string;

  /**
   * Template variables to inject. The referenced Template owns all visual structure; these fill its
   * declared variables. Optional — a Template with no variables needs none.
   */
  variables?: TransactionalVariables;

  /**
   * Stream this send belongs to (`digest` | `alert`). REQUIRED — it scopes the `List-Unsubscribe`
   * token (R33/R46). A missing/empty stream is rejected before any Resend contact (R45).
   */
  stream: Stream;

  /**
   * Topic this send belongs to. Scopes the suppression gate AND the unsubscribe token to a single
   * `(contact, topic, stream)` so a one-click opt-out leaves the recipient's other topics intact
   * (R33). Required for the same reason the stream is: a transactional email with no topic has no
   * place to scope its opt-out.
   */
  topicKey: string;

  /**
   * Idempotency key forwarded to Resend as the `Idempotency-Key` request HEADER (NOT a body field)
   * for exactly-once delivery on retry (R46). Optional — a one-shot send may forgo it, but a host
   * that may retry should always supply a stable key.
   */
  idempotencyKey?: string;

  /**
   * Sender address. Falls back to the stream's configured `from` default (`createEnvoy`'s
   * `streams[stream].from`) when omitted. A send with neither is rejected (R45-style fail-loud:
   * Resend requires a verified From).
   */
  from?: string;

  /** Optional subject override. When omitted the Resend Template's own subject is used. */
  subject?: string;

  /** Optional reply-to address(es). */
  replyTo?: string | string[];
}

/** Why a transactional send did not dispatch (when `sent` is false). */
export type TransactionalSkipReason =
  | "suppressed" // mirror gate denied (global unsubscribe or topic opt_out for this stream)
  | "resend_disabled"; // no Resend API key — silent no-op (R43)

/** Outcome of a {@link sendTransactional}. */
export type TransactionalSendResult =
  | {
      /** True when Resend accepted the email. */
      sent: true;
      /** The Resend email id returned by `emails.send`. */
      emailId: string;
    }
  | {
      sent: false;
      /** Why nothing was sent. */
      reason: TransactionalSkipReason;
    };

/**
 * Error thrown by {@link sendTransactional} for a HOST-CONTRACT violation it must fail loud on
 * (missing stream/topic/template/from, or a hard Resend error) — distinct from the fail-soft
 * `{ sent: false }` outcomes (suppression, no key) which are normal control flow, not errors.
 */
export class TransactionalSendError extends Error {
  constructor(message: string) {
    super(`[@envoy/sdk] ${message}`);
    this.name = "TransactionalSendError";
  }
}

/** Config the transactional sender needs beyond the Envoy handle. */
export interface TransactionalSendConfig {
  /** The consent mirror to gate against (U6). */
  mirror: ConsentMirror;
  /**
   * Absolute, already-mounted, `https` unsubscribe landing URL (e.g.
   * `https://app.example.com/api/envoy/unsubscribe`). The signed token is appended as `?token=…`.
   * Required — without it there is no place for the `List-Unsubscribe` header to point (R33).
   */
  unsubscribeBaseUrl: string;
}

/**
 * Resolve the sender address: explicit `from` wins, else the stream's configured default. Throws a
 * fail-loud contract error when neither is present (Resend rejects a send with no verified From, and
 * we want that as an early, named error rather than an opaque Resend 422).
 */
function resolveFrom(envoy: Envoy, input: TransactionalSendInput): string {
  if (typeof input.from === "string" && input.from.trim().length > 0) {
    return input.from;
  }
  const streamDefault = envoy.config.streams[input.stream]?.from;
  if (typeof streamDefault === "string" && streamDefault.trim().length > 0) {
    return streamDefault;
  }
  throw new TransactionalSendError(
    `send.transactional has no From address: pass \`from\` or configure streams.${input.stream}.from at createEnvoy time.`
  );
}

/**
 * Validate the required inputs and fail LOUD (R45). Stream + topicKey + templateId are all
 * required at the call boundary — the unit spec pins "U10 enforces [the missing-stream rejection]
 * at its call boundary." A `Stream` is a TypeScript union, but a host calling from untyped JS can
 * still pass an empty/unknown value, so we check at runtime.
 */
function validateInput(input: TransactionalSendInput): void {
  if (input === null || typeof input !== "object") {
    throw new TransactionalSendError("send.transactional requires an input object.");
  }
  if (typeof input.email !== "string" || input.email.trim().length === 0) {
    throw new TransactionalSendError("send.transactional requires a non-empty email.");
  }
  if (input.stream !== "digest" && input.stream !== "alert") {
    throw new TransactionalSendError(
      "send.transactional requires a `stream` of 'digest' or 'alert' — it scopes the List-Unsubscribe token (R33/R46); a send with no stream is rejected, never sent with a malformed unsubscribe."
    );
  }
  if (typeof input.topicKey !== "string" || input.topicKey.trim().length === 0) {
    throw new TransactionalSendError(
      "send.transactional requires a non-empty `topicKey` — it scopes the suppression gate and the one-click unsubscribe."
    );
  }
  if (typeof input.templateId !== "string" || input.templateId.trim().length === 0) {
    throw new TransactionalSendError("send.transactional requires a non-empty `templateId`.");
  }
}

/**
 * Send one transactional (non-AI) templated email through Resend (R46). Order is load-bearing:
 *
 *   1. Validate inputs — fail loud on a missing stream/topic/template/email (R45). NOTHING touches
 *      Resend or the contact before this passes.
 *   2. Resolve the From address (explicit or stream default) — fail loud if neither.
 *   3. GATE against the mirror (R26). A suppressed contact returns `{ sent: false, reason:
 *      "suppressed" }` — no Resend call. The gate reads the mirror only (cheap, deterministic).
 *   4. If Resend is unset, silent no-op `{ sent: false, reason: "resend_disabled" }` (R43).
 *   5. Build the RFC 8058 `List-Unsubscribe` headers pointing at the SDK-owned landing (R33).
 *   6. `emails.send({ template: { id, variables }, to, from, headers, subject? }, { idempotencyKey })`
 *      — the idempotency key is the REQUEST OPTION (`Idempotency-Key` header), never a body field.
 *   7. A Resend in-band `error` is a fail-loud `TransactionalSendError` (the host asked to send a
 *      one-shot email and Resend refused — unlike the drip lane there is no later tick to retry it).
 */
export async function sendTransactional(
  envoy: Envoy,
  input: TransactionalSendInput,
  config: TransactionalSendConfig
): Promise<TransactionalSendResult> {
  // 1. Validate — fail loud (R45).
  validateInput(input);

  if (
    config === null ||
    typeof config !== "object" ||
    typeof config.unsubscribeBaseUrl !== "string" ||
    config.unsubscribeBaseUrl.trim().length === 0
  ) {
    throw new TransactionalSendError(
      "send.transactional requires config.unsubscribeBaseUrl (the absolute https landing URL the List-Unsubscribe header points at)."
    );
  }

  // 2. Resolve From (fail loud if neither explicit nor stream default).
  const from = resolveFrom(envoy, input);

  // 3. Gate against the mirror FIRST (R26). A suppressed contact is never sent.
  const allowed = await config.mirror.gate(input.email, input.topicKey, input.stream);
  if (!allowed) {
    return { sent: false, reason: "suppressed" };
  }

  // 4. No Resend key ⇒ silent no-op (R43).
  const client = envoy.resend.client();
  if (!envoy.resend.enabled || client === null) {
    return { sent: false, reason: "resend_disabled" };
  }

  // 5. RFC 8058 one-click List-Unsubscribe headers (R33). `buildListUnsubscribeHeaders` itself
  //    enforces the https + 60-day-TTL compliance floor and throws on a non-https base URL.
  const unsubHeaders = buildListUnsubscribeHeaders(
    { email: input.email, topicKey: input.topicKey, stream: input.stream },
    envoy.config.unsubscribeSecret,
    config.unsubscribeBaseUrl
  );

  // 6. Send. `template` is the templated arm of CreateEmailOptions (from/subject optional there).
  //    The idempotency key is the SECOND arg (the `Idempotency-Key` request header), NOT a body
  //    field — putting it in the body would be silently dropped by Resend.
  const payload = {
    to: input.email,
    from,
    template: {
      id: input.templateId,
      ...(input.variables ? { variables: input.variables } : {}),
    },
    headers: {
      "List-Unsubscribe": unsubHeaders["List-Unsubscribe"],
      "List-Unsubscribe-Post": unsubHeaders["List-Unsubscribe-Post"],
    },
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
  };

  const requestOptions =
    input.idempotencyKey !== undefined
      ? { idempotencyKey: input.idempotencyKey }
      : undefined;

  let response: Awaited<ReturnType<typeof client.emails.send>>;
  try {
    // Cast to the NAMED target type (`emails.send`'s payload `CreateEmailOptions`), not `as never`.
    // resend@6.14.0 types `CreateEmailOptions` as a union: a content arm (`RequireAtLeastOne<html|
    // text|react>` + `template?: never`) and a templated arm (`template` required + `react|html|text:
    // never`). The annotation pins our template-only payload to the templated arm. Unlike `as never`
    // — which suppressed ALL payload typechecking — `as CreateEmailOptions` is a checked assertion:
    // the payload is still verified structurally assignable to the real target, so any future drift
    // (a misspelled `to`/`from`/`headers`/`template`/`subject`/`replyTo` field) is caught. Applied
    // identically in drip/engine.ts.
    response = await client.emails.send(payload as CreateEmailOptions, requestOptions);
  } catch (err) {
    // A thrown transport error: the host asked for a one-shot send and the transport failed. This
    // is fail-loud (no later tick to retry, unlike the drip engine). The message is generic — no
    // recipient address or secret leaks (R43).
    throw new TransactionalSendError(
      `transactional emails.send threw: ${err instanceof Error ? err.message : "unknown transport error"}.`
    );
  }

  const { data, error } = response;
  if (error || !data) {
    throw new TransactionalSendError(
      `transactional emails.send failed: ${error?.message ?? "unknown error"}.`
    );
  }

  return { sent: true, emailId: data.id };
}
