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

/**
 * A file attached to a transactional send (e.g. the booking-confirmation `.ics` calendar invite).
 * Maps onto Resend's `Attachment`: `content` is the file bytes (a base64/utf-8 string or Buffer) and
 * `contentType` is derived from `filename` when omitted.
 */
export interface TransactionalAttachment {
  /** File name including extension, e.g. `"invite.ics"`. */
  filename: string;
  /** File content — a string (base64 or utf-8, e.g. an iCalendar body) or a Buffer. */
  content: string | Buffer;
  /** MIME type, e.g. `"text/calendar"`. Derived from `filename` when omitted. */
  contentType?: string;
}

/** Fields common to both transactional lanes (the standard consent-gated lane and the `system` lane). */
export interface TransactionalSendBase {
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
   * Idempotency key forwarded to Resend as the `Idempotency-Key` request HEADER (NOT a body field)
   * for exactly-once delivery on retry (R46). Optional — a one-shot send may forgo it, but a host
   * that may retry should always supply a stable key.
   */
  idempotencyKey?: string;

  /**
   * Sender address. Falls back to the stream's configured `from` default (`createEnvoy`'s
   * `streams[stream].from`) when omitted. A send with neither is rejected (Resend requires a verified
   * From). A `system` send with no `stream` MUST supply `from` explicitly.
   */
  from?: string;

  /** Optional subject override. When omitted the Resend Template's own subject is used. */
  subject?: string;

  /** Optional reply-to address(es). */
  replyTo?: string | string[];

  /**
   * Optional file attachments (e.g. the booking `.ics`). Forwarded to Resend's `emails.send`
   * `attachments` (templated arm supports them); max 40 MB per email (Resend limit).
   */
  attachments?: TransactionalAttachment[];
}

/**
 * Inputs to {@link sendTransactional} (origin R46; system lane KTD7) — a discriminated union on
 * `system`:
 *
 *  - **Standard lane** (`system` absent/`false`): consent-gated against the mirror and carries an
 *    RFC 8058 `List-Unsubscribe`. `stream` + `topicKey` are REQUIRED — they scope the suppression
 *    gate and the one-click opt-out.
 *  - **System lane** (`system: true`): legitimate-interest / transactional-critical mail (a paid
 *    booking receipt). NOT gated by per-topic/stream consent and carries NO `List-Unsubscribe`, so a
 *    *marketing* opt-out can never suppress it — BUT it still honors the global hard-suppression
 *    floor (global unsubscribe, bounce/complaint, GDPR delete). `stream`/`topicKey` are optional (a
 *    system send has no consent scope; `stream`, if given, only supplies the From default).
 *    `templateId` MUST be in `createEnvoy`'s `systemTemplateIds` allow-list or the send throws
 *    {@link SystemLaneViolation} — so marketing copy cannot ride the lane by passing `system: true`.
 */
export type TransactionalSendInput =
  | (TransactionalSendBase & {
      /** Standard consumer lane (default). Consent-gated + List-Unsubscribe. */
      system?: false;
      /** Stream (`digest` | `alert`) — REQUIRED here; scopes the List-Unsubscribe token (R33/R46). */
      stream: Stream;
      /** Topic — REQUIRED here; scopes the suppression gate + the one-click opt-out (R33). */
      topicKey: string;
    })
  | (TransactionalSendBase & {
      /** Legitimate-interest / transactional-critical lane (KTD7). Floor-gated, no unsubscribe. */
      system: true;
      /** Optional here — used only to resolve the From default, never for consent scoping. */
      stream?: Stream;
      /** Optional here — a system send has no per-topic consent scope. */
      topicKey?: string;
    });

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
    super(`[@catalystiq/envoy-sdk] ${message}`);
    this.name = "TransactionalSendError";
  }
}

/**
 * Thrown when a `system: true` send names a `templateId` that is NOT in `createEnvoy`'s
 * `systemTemplateIds` allow-list (KTD7). The non-gated system lane bypasses marketing consent, so
 * eligibility is enforced IN the SDK: a missed host-side check — or a copy-paste that passes
 * `system: true` for a marketing template — fails loud here rather than letting marketing copy ride
 * the non-suppressible lane. Distinct from {@link TransactionalSendError} so a host can catch the
 * governance violation specifically.
 */
export class SystemLaneViolation extends Error {
  constructor(message: string) {
    super(`[@catalystiq/envoy-sdk] ${message}`);
    this.name = "SystemLaneViolation";
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
  // A system send may carry no `stream`; only consult a stream default when a stream is present.
  const streamDefault =
    input.stream !== undefined ? envoy.config.streams[input.stream]?.from : undefined;
  if (typeof streamDefault === "string" && streamDefault.trim().length > 0) {
    return streamDefault;
  }
  throw new TransactionalSendError(
    input.stream !== undefined
      ? `send.transactional has no From address: pass \`from\` or configure streams.${input.stream}.from at createEnvoy time.`
      : "send.transactional (system lane) has no From address: a system send with no `stream` must pass an explicit `from`."
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
  if (typeof input.templateId !== "string" || input.templateId.trim().length === 0) {
    throw new TransactionalSendError("send.transactional requires a non-empty `templateId`.");
  }
  if (input.system === true) {
    // System lane: stream/topicKey are OPTIONAL (no consent scope). A supplied stream must still be
    // a valid value — it only resolves the From default, never consent.
    if (
      input.stream !== undefined &&
      input.stream !== "digest" &&
      input.stream !== "alert"
    ) {
      throw new TransactionalSendError(
        "send.transactional `stream`, when provided on a system send, must be 'digest' or 'alert'."
      );
    }
    return;
  }
  // Standard lane: stream + topicKey are REQUIRED — they scope the gate + the List-Unsubscribe token.
  if (input.stream !== "digest" && input.stream !== "alert") {
    throw new TransactionalSendError(
      "send.transactional requires a `stream` of 'digest' or 'alert' — it scopes the List-Unsubscribe token (R33/R46); a send with no stream is rejected. For a non-suppressible receipt, use `system: true`."
    );
  }
  if (typeof input.topicKey !== "string" || input.topicKey.trim().length === 0) {
    throw new TransactionalSendError(
      "send.transactional requires a non-empty `topicKey` — it scopes the suppression gate and the one-click unsubscribe."
    );
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

  // Both lanes gate against the mirror, so config + its mirror are required regardless of lane.
  if (config === null || typeof config !== "object" || config.mirror == null) {
    throw new TransactionalSendError(
      "send.transactional requires a config with a consent `mirror`."
    );
  }

  if (input.system === true) {
    // 1b. SYSTEM lane: enforce the systemTemplateIds allow-list IN the SDK (KTD7). The non-gated lane
    //     bypasses marketing consent, so a template not declared system-eligible must not ride it —
    //     fail loud rather than silently send marketing copy on the unsubscribe-less lane.
    if (!envoy.config.systemTemplateIds.has(input.templateId)) {
      throw new SystemLaneViolation(
        `templateId "${input.templateId}" is not in createEnvoy's systemTemplateIds allow-list. ` +
          "The system lane is for legitimate-interest transactional mail only; declare the template " +
          "in systemTemplateIds, or send it on the standard (consent-gated) lane."
      );
    }
  } else {
    // STANDARD lane needs the unsubscribe landing URL (the system lane sends no List-Unsubscribe).
    if (
      typeof config.unsubscribeBaseUrl !== "string" ||
      config.unsubscribeBaseUrl.trim().length === 0
    ) {
      throw new TransactionalSendError(
        "send.transactional requires config.unsubscribeBaseUrl (the absolute https landing URL the List-Unsubscribe header points at)."
      );
    }
  }

  // 2. Resolve From (fail loud if neither explicit nor stream default).
  const from = resolveFrom(envoy, input);

  // 3. Suppression gate. STANDARD lane: the full per-topic/stream consent gate (R26). SYSTEM lane:
  //    ONLY the global hard-suppression floor (global unsubscribe / bounce / complaint / GDPR
  //    delete) — a *marketing* opt-out can never drop a paid receipt, but a globally-suppressed
  //    contact must still never be mailed (KTD7).
  let allowed: boolean;
  if (input.system === true) {
    allowed = !(await config.mirror.isGloballySuppressed(input.email));
  } else {
    allowed = await config.mirror.gate(input.email, input.topicKey, input.stream);
  }
  if (!allowed) {
    return { sent: false, reason: "suppressed" };
  }

  // 4. No Resend key ⇒ silent no-op (R43).
  const client = envoy.resend.client();
  if (!envoy.resend.enabled || client === null) {
    return { sent: false, reason: "resend_disabled" };
  }

  // 5. RFC 8058 one-click List-Unsubscribe headers (R33) — STANDARD lane only. The system lane is
  //    legitimate-interest transactional mail and carries NO unsubscribe (KTD7); injecting one would
  //    let a recipient suppress their own receipts. `buildListUnsubscribeHeaders` enforces the
  //    https + 60-day-TTL compliance floor and throws on a non-https base URL.
  const unsubHeaders =
    input.system === true
      ? null
      : buildListUnsubscribeHeaders(
          { email: input.email, topicKey: input.topicKey, stream: input.stream },
          envoy.config.unsubscribeSecret,
          config.unsubscribeBaseUrl
        );

  // 6. Send. `template` is the templated arm of CreateEmailOptions (from/subject optional there).
  //    The idempotency key is the SECOND arg (the `Idempotency-Key` request header), NOT a body
  //    field. Attachments (e.g. the booking .ics) ride the templated arm's `attachments`.
  const payload = {
    to: input.email,
    from,
    template: {
      id: input.templateId,
      ...(input.variables ? { variables: input.variables } : {}),
    },
    ...(unsubHeaders
      ? {
          headers: {
            "List-Unsubscribe": unsubHeaders["List-Unsubscribe"],
            "List-Unsubscribe-Post": unsubHeaders["List-Unsubscribe-Post"],
          },
        }
      : {}),
    ...(input.subject !== undefined ? { subject: input.subject } : {}),
    ...(input.replyTo !== undefined ? { replyTo: input.replyTo } : {}),
    ...(input.attachments && input.attachments.length > 0
      ? { attachments: input.attachments }
      : {}),
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
