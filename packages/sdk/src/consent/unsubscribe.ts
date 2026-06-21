import "server-only";

import crypto from "node:crypto";

// SDK-owned, signed, topic-scoped unsubscribe landing + List-Unsubscribe header builder
// (U6 / origin R33, RFC 8058, KTD9).
//
// The drip / transactional lane CANNOT use Resend's native broadcast unsubscribe (broadcasts carry
// the `{{{RESEND_UNSUBSCRIBE_URL}}}` link, but `emails.send` does not). So for `emails.send` the
// SDK sets its own RFC 8058 one-click headers pointing at a landing handler this module owns:
//
//   List-Unsubscribe: <https://host/<base>/unsubscribe?token=…>
//   List-Unsubscribe-Post: List-Unsubscribe=One-Click
//
// The token is HMAC-SHA256 over `(contact, topicKey, stream, exp)` keyed by the dedicated
// `unsubscribeSecret`. A one-click POST verifies the token and writes a TOPIC-SCOPED `opt_out`
// (NOT a global unsubscribe — the recipient asked to leave THIS stream of THIS topic). The landing:
//   - rejects expired or forged tokens (mandatory expiry ≥ 60 days per CAN-SPAM / RFC 8058),
//   - returns 200 with a blank body and NO redirect on success (RFC 8058 one-click),
//   - is rate-limited per client IP,
//   - returns UNIFORM responses so there is no valid-vs-invalid / subscribed-vs-already oracle.
//
// Security notes:
//   - HMAC verification is constant-time (`crypto.timingSafeEqual`, mirroring the app's
//     `lib/webhook-auth.ts`), and length-checks before comparing so unequal-length buffers don't
//     throw.
//   - The token is signed over a canonical JSON payload; we re-serialize canonically on verify so
//     a re-ordered/whitespace-altered payload cannot validate.

import type { ConsentMirror, Stream } from "./mirror.js";
import type { NamespacedDb } from "../db/pool.js";

/** Minimum token lifetime: 60 days. CAN-SPAM requires an opt-out mechanism that stays live for at
 * least 30 days post-send; RFC 8058 one-click links are long-lived. We floor at 60d and reject any
 * caller-supplied TTL below it (a too-short link is a compliance hole, fail loud at build time). */
export const MIN_UNSUBSCRIBE_TTL_SECONDS = 60 * 24 * 60 * 60;

/** The signed claims inside an unsubscribe token. `exp` is a Unix epoch SECONDS expiry. */
export interface UnsubscribeClaims {
  /** Bare recipient email (the contact key). */
  contact: string;
  /** Topic the opt-out applies to. */
  topicKey: string;
  /** Stream of the topic the opt-out applies to. */
  stream: Stream;
  /** Expiry, Unix epoch seconds. */
  exp: number;
}

/**
 * Canonical serialization of the claims for signing/verifying. Field order is FIXED here (not
 * `JSON.stringify(obj)` over an arbitrary key order) so the signed bytes are stable regardless of
 * how the claims object was constructed.
 */
function canonicalize(claims: UnsubscribeClaims): string {
  return JSON.stringify({
    contact: claims.contact,
    topicKey: claims.topicKey,
    stream: claims.stream,
    exp: claims.exp,
  });
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

function fromBase64url(s: string): Buffer {
  return Buffer.from(s, "base64url");
}

/**
 * Sign claims into a `<payload>.<sig>` token. `payload` is base64url(canonical JSON); `sig` is
 * base64url(HMAC-SHA256(payload)). The secret is the install's dedicated `unsubscribeSecret`.
 */
function sign(claims: UnsubscribeClaims, secret: string): string {
  const payload = base64url(Buffer.from(canonicalize(claims), "utf8"));
  const sig = base64url(
    crypto.createHmac("sha256", secret).update(payload).digest()
  );
  return `${payload}.${sig}`;
}

/** Result of verifying a token: the claims on success, or a reason on failure. Callers MUST NOT
 * surface the reason to the client (uniform responses / no oracle) — it is for internal logging
 * only, and even then the contact is redacted at the log site. */
export type VerifyResult =
  | { ok: true; claims: UnsubscribeClaims }
  | { ok: false; reason: "malformed" | "bad_signature" | "expired" };

/**
 * Verify a token against the secret with a constant-time signature compare and an expiry check.
 * Returns the decoded claims on success. NEVER throws on attacker-controlled input — a malformed
 * token is a typed failure, not an exception.
 */
export function verifyUnsubscribeToken(
  token: string,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): VerifyResult {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, reason: "malformed" };
  }
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) {
    return { ok: false, reason: "malformed" };
  }
  const payload = token.slice(0, dot);
  const providedSig = token.slice(dot + 1);

  const expectedSig = base64url(
    crypto.createHmac("sha256", secret).update(payload).digest()
  );
  const a = Buffer.from(providedSig);
  const b = Buffer.from(expectedSig);
  // Length-check first: timingSafeEqual throws on unequal lengths. This is not a timing leak — the
  // signature length is fixed for a valid token, so an attacker learns only that their forgery had
  // the wrong length, which they already know.
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return { ok: false, reason: "bad_signature" };
  }

  let claims: UnsubscribeClaims;
  try {
    const decoded = JSON.parse(fromBase64url(payload).toString("utf8")) as unknown;
    if (
      decoded === null ||
      typeof decoded !== "object" ||
      typeof (decoded as UnsubscribeClaims).contact !== "string" ||
      typeof (decoded as UnsubscribeClaims).topicKey !== "string" ||
      ((decoded as UnsubscribeClaims).stream !== "digest" &&
        (decoded as UnsubscribeClaims).stream !== "alert") ||
      typeof (decoded as UnsubscribeClaims).exp !== "number"
    ) {
      return { ok: false, reason: "malformed" };
    }
    claims = decoded as UnsubscribeClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }

  // Re-sign the canonical form of the DECODED claims and compare to the provided payload. This
  // closes a payload-malleability gap: even if some encoder produced a payload that base64-decodes
  // to equivalent-but-not-byte-identical JSON, only the canonical byte string validates.
  if (sign(claims, secret).split(".")[0] !== payload) {
    return { ok: false, reason: "bad_signature" };
  }

  if (!Number.isFinite(claims.exp) || claims.exp <= nowSeconds) {
    return { ok: false, reason: "expired" };
  }
  return { ok: true, claims };
}

/** Options for minting an unsubscribe token (drip/transactional lane). */
export interface CreateTokenInput {
  email: string;
  topicKey: string;
  stream: Stream;
  /** Token lifetime in seconds. Defaults to and floored at `MIN_UNSUBSCRIBE_TTL_SECONDS` (60d). */
  ttlSeconds?: number;
}

/**
 * Mint a signed, expiring, topic+stream-scoped unsubscribe token. Throws if the requested TTL is
 * below the 60-day compliance floor (fail loud at build time, not silently shorten).
 */
export function createUnsubscribeToken(
  input: CreateTokenInput,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const ttl = input.ttlSeconds ?? MIN_UNSUBSCRIBE_TTL_SECONDS;
  if (ttl < MIN_UNSUBSCRIBE_TTL_SECONDS) {
    throw new Error(
      `[@envoy/sdk] unsubscribe token TTL must be >= ${MIN_UNSUBSCRIBE_TTL_SECONDS}s (60 days, RFC 8058 / CAN-SPAM); got ${ttl}.`
    );
  }
  return sign(
    {
      contact: input.email,
      topicKey: input.topicKey,
      stream: input.stream,
      exp: nowSeconds + ttl,
    },
    secret
  );
}

/** Built RFC 8058 one-click headers for a single `emails.send` call. */
export interface ListUnsubscribeHeaders {
  "List-Unsubscribe": string;
  "List-Unsubscribe-Post": string;
}

/**
 * Build the `List-Unsubscribe` + `List-Unsubscribe-Post` headers for a drip/transactional send
 * (R33). The URL points at the SDK-owned landing under the host's mounted base path. `baseUrl` is
 * the absolute, already-mounted unsubscribe endpoint (e.g. `https://app.example.com/api/envoy/unsubscribe`);
 * the token is appended as a query param.
 *
 * RFC 8058: the presence of `List-Unsubscribe-Post: List-Unsubscribe=One-Click` tells the MUA the
 * `List-Unsubscribe` URL accepts a POST one-click. The URL MUST be `https`.
 */
export function buildListUnsubscribeHeaders(
  input: CreateTokenInput,
  secret: string,
  baseUrl: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): ListUnsubscribeHeaders {
  if (!/^https:\/\//i.test(baseUrl)) {
    throw new Error(
      "[@envoy/sdk] unsubscribe baseUrl must be an absolute https URL (RFC 8058 one-click)."
    );
  }
  const token = createUnsubscribeToken(input, secret, nowSeconds);
  const sep = baseUrl.includes("?") ? "&" : "?";
  const url = `${baseUrl}${sep}token=${encodeURIComponent(token)}`;
  return {
    "List-Unsubscribe": `<${url}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}

// ---------------------------------------------------------------------------------------------
// Rate limiter (DB-backed fixed window — reimplements the app's lib/rate-limit.ts behavior)
// ---------------------------------------------------------------------------------------------

/** Default unsubscribe-landing rate limit: 20 requests / 60s per client IP. Generous enough for a
 * real MUA's prefetch + the human's click, tight enough to blunt token-guessing fan-out. */
export const DEFAULT_UNSUB_RATE_LIMIT = 20;
export const DEFAULT_UNSUB_RATE_WINDOW_SECONDS = 60;

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfterSeconds: number;
}

/**
 * Atomic fixed-window limiter over `sdk_rate_limits`. The window resets when `window_start` ages
 * past `windowSeconds`, otherwise the counter increments. Allowed while the post-increment count
 * is within `limit`. FAILS OPEN on a DB error: a limiter outage must not lock every recipient out
 * of unsubscribing (an unreachable opt-out is itself a compliance failure).
 */
export async function checkRateLimit(
  db: NamespacedDb,
  bareKey: string,
  limit: number,
  windowSeconds: number
): Promise<RateLimitResult> {
  const key = db.namespaceKey(bareKey);
  try {
    const res = await db.query<{ count: number }>(
      `INSERT INTO sdk_rate_limits (namespace, key, count, window_start)
       VALUES ($1, $2, 1, NOW())
       ON CONFLICT (namespace, key) DO UPDATE SET
         count = CASE
           WHEN sdk_rate_limits.window_start < NOW() - make_interval(secs => $3)
           THEN 1
           ELSE sdk_rate_limits.count + 1
         END,
         window_start = CASE
           WHEN sdk_rate_limits.window_start < NOW() - make_interval(secs => $3)
           THEN NOW()
           ELSE sdk_rate_limits.window_start
         END
       RETURNING count`,
      [db.namespace, key, windowSeconds]
    );
    const count = Number(res.rows[0]?.count ?? 0);
    return {
      allowed: count <= limit,
      remaining: Math.max(0, limit - count),
      retryAfterSeconds: windowSeconds,
    };
  } catch {
    return { allowed: true, remaining: limit, retryAfterSeconds: 0 };
  }
}

/** Best-effort client IP from proxy headers — rate-limit bucket key only, never authorization. */
export function clientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() || "unknown";
  return request.headers.get("x-real-ip") || "unknown";
}

// ---------------------------------------------------------------------------------------------
// Landing handler
// ---------------------------------------------------------------------------------------------

/** Config the landing handler needs: the verifying secret, the mirror to write the opt-out into,
 * the namespaced DB for rate-limiting, and optional limiter tunables. */
export interface UnsubscribeLandingConfig {
  secret: string;
  mirror: ConsentMirror;
  db: NamespacedDb;
  rateLimit?: { limit?: number; windowSeconds?: number };
}

/**
 * Uniform success/invalid response. Per RFC 8058 + the no-oracle requirement, BOTH the
 * already-unsubscribed and just-unsubscribed cases — and even a forged/expired token — produce the
 * SAME 200 blank body so an attacker learns nothing about whether a token was valid or a contact
 * was subscribed. Only a rate-limit trip (429) and a non-POST method (405) differ, and neither
 * leaks token validity.
 */
function uniformOk(): Response {
  return new Response(null, {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Handle a one-click unsubscribe request (RFC 8058). Expects a POST with the token in the
 * `token` query param (the `List-Unsubscribe` URL) — a GET is also accepted for MUAs/humans that
 * open the link in a browser, but per RFC 8058 the one-click action is the POST.
 *
 * Behavior:
 *   - Rate-limit by client IP first; over the limit → 429 (uniform, no body detail).
 *   - Verify the token. Forged/expired/malformed → uniform 200 blank, NO state change.
 *   - On a valid token, write a TOPIC-SCOPED `opt_out` via the mirror (NOT a global unsubscribe)
 *     and return uniform 200 blank. Already-opted-out is the same response (monotonic no-op).
 *   - Never 500 on attacker input; never redirect.
 */
export async function handleUnsubscribe(
  request: Request,
  config: UnsubscribeLandingConfig
): Promise<Response> {
  const method = request.method.toUpperCase();
  if (method !== "POST" && method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  }

  // 1. Rate limit (fail-open inside checkRateLimit).
  const limit = config.rateLimit?.limit ?? DEFAULT_UNSUB_RATE_LIMIT;
  const windowSeconds =
    config.rateLimit?.windowSeconds ?? DEFAULT_UNSUB_RATE_WINDOW_SECONDS;
  const ip = clientIp(request);
  const rl = await checkRateLimit(config.db, `unsubscribe:${ip}`, limit, windowSeconds);
  if (!rl.allowed) {
    return new Response(null, {
      status: 429,
      headers: { "retry-after": String(rl.retryAfterSeconds) },
    });
  }

  // 2. Extract + verify the token. Any failure → uniform 200 (no oracle), no state change.
  let token: string | null = null;
  try {
    token = new URL(request.url).searchParams.get("token");
  } catch {
    token = null;
  }
  if (token === null) return uniformOk();

  const verdict = verifyUnsubscribeToken(token, config.secret);
  if (!verdict.ok) {
    // Forged / expired / malformed: do nothing, respond identically to success.
    return uniformOk();
  }

  // 3. Write the TOPIC-SCOPED opt-out (not global). Fail-soft: any error in the mirror push is
  // already swallowed by `mirror.set` (it never throws on a Resend failure); we additionally guard
  // the whole write so an unexpected DB error still yields the uniform 200 rather than a 500 oracle.
  try {
    await config.mirror.set({
      email: verdict.claims.contact,
      topicKey: verdict.claims.topicKey,
      stream: verdict.claims.stream,
      status: "opt_out",
    });
  } catch {
    // Even a hard write failure responds uniformly — but this is an internal error worth the
    // host's monitoring. We intentionally do not leak it to the client.
  }

  return uniformOk();
}
