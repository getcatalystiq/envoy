import "server-only";

import { timingSafeEqual } from "node:crypto";

import { Webhook } from "svix";

import type { Envoy } from "../config.js";
import {
  tickDrip,
  type DripTickConfig,
  type DripTickResult,
  type SequenceRegistry,
} from "../drip/engine.js";

// Route-handler factory with per-sub-path auth (U4 / origin R2, R6, R40, R41, R42, KTD8).
//
// One catch-all route is mounted by the host (e.g. app/api/envoy/[...envoy]/route.ts). This
// factory returns App Router-compatible GET/POST handlers that:
//
//   1. Parse the sub-path (the segment AFTER the mount base) and dispatch.
//   2. Authenticate EACH sub-path with its OWN mechanism — never uniformly (KTD8):
//        /api, /read   → host authorize(req)                (R6)
//        /cron         → constant-time CRON_SECRET compare  (R40)  — fail-closed unset (non-dev)
//        /webhook      → Svix signature verify              (R41)  — bypasses authorize
//        /unsubscribe  → its own signed token (U6)          (R33)  — bypasses authorize
//        /mcp          → dedicated MCP credential            (R42)  — never open
//   3. Run the sub-path's body ONLY after its auth gate passes. An unauthenticated request to
//      ANY path is rejected (401), and an unknown sub-path is a 404. There is no path that
//      reaches host logic without first clearing an auth check.
//
// Reimplements (never imports) the app patterns the unit cites:
//   - lib/cron-utils.ts  → constant-time CRON_SECRET compare, dev-only unset allowance.
//   - lib/webhook-auth.ts → length-checked timingSafeEqual (no early-out on length).
//   - the SES webhook handler's never-500 posture is honored by U5; U4 only owns the auth gate
//     and delegates the verified body to the injected sub-handler.

/**
 * Result a sub-handler must return: an App-Router-compatible `Response`. Sub-handlers receive the
 * raw `Request` (already authenticated by the factory) plus the parsed sub-path tail.
 */
export type SubHandler = (request: Request) => Response | Promise<Response>;

/**
 * Host `authorize(req)` callback (R6). The host owns identity; the SDK ships no login/session.
 *
 * CONTRACT — the return value is interpreted strictly:
 *   - `true`  ⇒ authorized; the request proceeds to the sub-handler. The boolean `true` is the
 *               ONLY value that grants access. Nothing else does.
 *   - a `Response` ⇒ a DENIAL channel ONLY. A non-2xx `Response` (e.g. a custom 401/403/redirect)
 *               is returned to the client verbatim. A 2xx `Response` is a host CONTRACT ERROR — an
 *               `authorize` callback must never signal "allowed" by returning a success Response —
 *               so the factory treats it as unauthorized (a generic 401), NEVER as authorized. This
 *               fail-closed reading means a host that accidentally returns `new Response("ok")` from
 *               authorize cannot open its entire API surface (an ambiguous-host-return admit).
 *   - any other falsy value (`false`, `undefined`, `null`) ⇒ a generic 401.
 */
export type Authorize = (request: Request) => AuthorizeResult | Promise<AuthorizeResult>;
export type AuthorizeResult = boolean | Response;

/**
 * Config for `createEnvoyHandler`. Every authenticated sub-path is optional EXCEPT the auth
 * mechanism that guards it. A sub-path with no handler still authenticates first, then returns 501
 * — so an attacker can never tell "unimplemented" from "unauthorized" without first passing auth.
 */
export interface EnvoyHandlerConfig {
  /** The root SDK handle (supplies `config.cronSecret`, `config.webhookSecret`, DB, redaction). */
  envoy: Envoy;
  /**
   * Host authorization for the `/api` and `/read` sub-paths (R6). Required: the API surface must
   * not be open. cron/webhook/unsubscribe/mcp do NOT use this — they carry no host session.
   */
  authorize: Authorize;
  /**
   * Dedicated MCP credential (R42). The `/mcp` sub-path is independently authenticated against
   * this secret with a constant-time compare. When omitted, `/mcp` fails closed (401) — it is
   * NEVER open.
   */
  mcpSecret?: string;
  /**
   * `"dev"` relaxes the unset-`CRON_SECRET` guard to allow unauthenticated cron locally (mirrors
   * the app's dev-only allowance). In any other environment an unset cron secret fails closed.
   * Defaults to `"prod"` (fail-closed) when omitted — safe by default.
   */
  environment?: string;

  /** Handler for `/api/*` (authenticated by `authorize`). */
  api?: SubHandler;
  /** Handler for `/read/*` (authenticated by `authorize`). Read-only host endpoints (hooks, U17). */
  read?: SubHandler;
  /** Handler for `/cron/*` (authenticated by `CRON_SECRET`). The drip/broadcast tick driver. */
  cron?: SubHandler;
  /** Handler for `/webhook/*` (authenticated by Svix). The Resend event ingest (U5). */
  webhook?: SubHandler;
  /** Handler for `/unsubscribe/*` (self-authenticating signed token, U6). */
  unsubscribe?: SubHandler;
  /** Handler for `/mcp/*` (authenticated by `mcpSecret`). The MCP endpoint (U16). */
  mcp?: SubHandler;
}

/** App Router route module shape: a `{ GET, POST }` pair of request handlers. */
export interface EnvoyRouteHandlers {
  GET: SubHandler;
  POST: SubHandler;
}

/** Known sub-paths. Anything else is a 404 (we never leak which unknown paths exist). */
const KNOWN_SUBPATHS = [
  "api",
  "read",
  "cron",
  "webhook",
  "unsubscribe",
  "mcp",
] as const;
type KnownSubpath = (typeof KNOWN_SUBPATHS)[number];

function isKnownSubpath(value: string): value is KnownSubpath {
  return (KNOWN_SUBPATHS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------------------------
// Constant-time secret comparison (reimplemented from lib/cron-utils.ts / lib/webhook-auth.ts)
// ---------------------------------------------------------------------------------------------

/**
 * Length-checked constant-time compare. A length mismatch short-circuits to `false` (you cannot
 * `timingSafeEqual` buffers of different lengths — it throws), which leaks only the length, never
 * the content. An empty `provided` or `expected` is always a non-match.
 *
 * Exported so the MCP route (route/mcp.ts), which authenticates the SAME dedicated credential with
 * the SAME constant-time discipline, imports this one implementation instead of carrying a copy —
 * a single audited timing-safe compare across every secret-auth seam in the route layer.
 */
export function secretsMatch(provided: string, expected: string): boolean {
  if (provided.length === 0 || expected.length === 0) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Pull a Bearer token out of the `authorization` header (the cron-secret convention). */
function bearerToken(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : header;
}

// ---------------------------------------------------------------------------------------------
// Uniform responses
// ---------------------------------------------------------------------------------------------

function unauthorized(): Response {
  return new Response("Unauthorized", { status: 401 });
}

function notFound(): Response {
  return new Response("Not Found", { status: 404 });
}

function notImplemented(): Response {
  // Reached ONLY after the sub-path's auth gate has passed — so this never doubles as an auth
  // oracle (you must already be authenticated to learn a handler is unwired).
  return new Response("Not Implemented", { status: 501 });
}

/**
 * Serialize `body` as a JSON `Response` with the given status. The single JSON-response helper for
 * the route layer — exported so the webhook receiver (and any other sub-handler) returns JSON
 * through one implementation instead of re-declaring an identical `new Response(JSON.stringify(...))`.
 */
export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

// ---------------------------------------------------------------------------------------------
// Sub-path resolution
// ---------------------------------------------------------------------------------------------

/**
 * Extract the dispatch sub-path segment from a request URL. The factory is mount-agnostic: the host
 * mounts the catch-all anywhere (`/api/envoy/...`, `/envoy/...`, etc.), so the SDK cannot know the
 * base length. The dispatch segment is the one the host appended AFTER the mount base, so we scan
 * for the LAST segment that matches a known sub-path — the deepest match is the action segment,
 * never a coincidental `api` in the mount base (e.g. `/api/envoy/cron/tick` → `cron`, and
 * `/api/envoy/api/enroll` → the second `api`). If no known segment appears, the sub-path is
 * `null` ⇒ 404. A trailing extra path after the sub-path (`/webhook/resend`) still resolves to
 * `webhook` because that is the last KNOWN segment.
 */
export function resolveSubpath(url: string): KnownSubpath | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const segments = pathname.split("/").filter((s) => s.length > 0);
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    const segment = segments[i];
    if (segment !== undefined && isKnownSubpath(segment)) return segment;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Per-sub-path auth gates
// ---------------------------------------------------------------------------------------------

/**
 * `/api` + `/read`: host authorize(req). A thrown `authorize` is treated as a denial (fail-closed),
 * never a 500 that might mask the auth decision.
 */
async function runAuthorize(authorize: Authorize, request: Request): Promise<Response | null> {
  let verdict: AuthorizeResult;
  try {
    verdict = await authorize(request);
  } catch {
    return unauthorized();
  }
  if (verdict instanceof Response) {
    // A `Response` from authorize is a DENIAL channel, never an authorization. Pass a non-2xx
    // through to the client verbatim (the host's own 401/403/redirect). A 2xx is a host contract
    // ERROR — authorize must signal "allowed" with the boolean `true`, not a success Response — so
    // we DO NOT continue; we fail closed with a generic 401. (Treating a 2xx as authorized would
    // let an accidental `new Response("ok")` open the whole API surface.)
    if (verdict.status >= 200 && verdict.status < 300) return unauthorized();
    return verdict;
  }
  // Only the explicit boolean `true` authorizes. Any other value (false/undefined/null) → 401.
  return verdict === true ? null : unauthorized();
}

/**
 * `/cron`: constant-time `CRON_SECRET` compare (R40). Fail-closed when the secret is unset outside
 * dev — an unauthenticated cron path is an unauthenticated send + AI-generation trigger.
 */
function runCronAuth(cronSecret: string, environment: string, request: Request): Response | null {
  if (cronSecret.length === 0) {
    if (environment === "dev") return null; // dev-only allowance (mirrors lib/cron-utils.ts)
    return unauthorized();
  }
  return secretsMatch(bearerToken(request), cronSecret) ? null : unauthorized();
}

/**
 * `/webhook`: Svix signature verify (R41). Verifies `svix-id`/`svix-timestamp`/`svix-signature`
 * over the RAW body BEFORE any parsing, bypassing host `authorize`. A forged/replayed/unsigned
 * webhook is rejected (401) and the body is never handed downstream. Returns the verified raw body
 * so the sub-handler does not have to re-read the (already-consumed) request stream.
 */
async function runWebhookAuth(
  webhookSecret: string,
  request: Request
): Promise<{ ok: true; rawBody: string } | { ok: false; response: Response }> {
  if (webhookSecret.length === 0) {
    // A missing webhook secret means we cannot verify ANY signature — fail closed.
    return { ok: false, response: unauthorized() };
  }

  const svixId = request.headers.get("svix-id");
  const svixTimestamp = request.headers.get("svix-timestamp");
  const svixSignature = request.headers.get("svix-signature");
  if (!svixId || !svixTimestamp || !svixSignature) {
    return { ok: false, response: unauthorized() };
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return { ok: false, response: unauthorized() };
  }

  try {
    const wh = new Webhook(webhookSecret);
    wh.verify(rawBody, {
      "svix-id": svixId,
      "svix-timestamp": svixTimestamp,
      "svix-signature": svixSignature,
    });
  } catch {
    // Bad signature, replay outside tolerance, or malformed headers — all are "unverified".
    return { ok: false, response: unauthorized() };
  }

  return { ok: true, rawBody };
}

/** `/mcp`: dedicated credential (R42). Never open — an unset/empty secret fails closed. */
function runMcpAuth(mcpSecret: string | undefined, request: Request): Response | null {
  const expected = typeof mcpSecret === "string" ? mcpSecret : "";
  if (expected.length === 0) return unauthorized();
  return secretsMatch(bearerToken(request), expected) ? null : unauthorized();
}

// ---------------------------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------------------------

/**
 * A webhook sub-handler may want the already-read raw body. We expose it via a request header-free
 * channel: a fresh `Request` carrying the verified body. The sub-handler reads it normally.
 */
function rebuildWebhookRequest(original: Request, rawBody: string): Request {
  return new Request(original.url, {
    method: original.method,
    headers: original.headers,
    body: rawBody,
  });
}

async function dispatch(config: EnvoyHandlerConfig, request: Request): Promise<Response> {
  const subpath = resolveSubpath(request.url);
  if (subpath === null) return notFound();

  const { envoy } = config;

  switch (subpath) {
    case "api":
    case "read": {
      const denied = await runAuthorize(config.authorize, request);
      if (denied) return denied;
      const handler = subpath === "api" ? config.api : config.read;
      return handler ? await handler(request) : notImplemented();
    }

    case "cron": {
      const environment = config.environment ?? "prod";
      const denied = runCronAuth(envoy.config.cronSecret, environment, request);
      if (denied) return denied;
      return config.cron ? await config.cron(request) : notImplemented();
    }

    case "webhook": {
      const verified = await runWebhookAuth(envoy.config.webhookSecret, request);
      if (!verified.ok) return verified.response;
      if (!config.webhook) return notImplemented();
      return await config.webhook(rebuildWebhookRequest(request, verified.rawBody));
    }

    case "unsubscribe": {
      // The unsubscribe sub-path self-authenticates via its signed token (U6 handleUnsubscribe),
      // so the factory does NOT gate it with `authorize`. It simply delegates; the handler itself
      // returns uniform responses (no token oracle) and is rate-limited internally.
      return config.unsubscribe ? await config.unsubscribe(request) : notImplemented();
    }

    case "mcp": {
      const denied = runMcpAuth(config.mcpSecret, request);
      if (denied) return denied;
      return config.mcp ? await config.mcp(request) : notImplemented();
    }
  }
}

/**
 * Build the mounted route handlers. The host wires the returned `{ GET, POST }` into a single
 * catch-all App Router route. Both verbs share one dispatcher; each sub-handler decides which
 * methods it accepts. Auth is enforced per sub-path before any handler body runs (KTD8).
 */
export function createEnvoyHandler(config: EnvoyHandlerConfig): EnvoyRouteHandlers {
  if (config === null || typeof config !== "object") {
    throw new TypeError("[@envoy/sdk] createEnvoyHandler(config) requires a config object.");
  }
  if (config.envoy === null || typeof config.envoy !== "object") {
    throw new TypeError("[@envoy/sdk] createEnvoyHandler requires an `envoy` handle.");
  }
  if (typeof config.authorize !== "function") {
    throw new TypeError(
      "[@envoy/sdk] createEnvoyHandler requires an `authorize(req)` callback — the API surface must not be open (R6)."
    );
  }

  const handle: SubHandler = (request: Request) => dispatch(config, request);
  return { GET: handle, POST: handle };
}

// =============================================================================================
// U9 — drip cron handler. The body the host wires as `createEnvoyHandler({ ..., cron })`. The
// route factory has ALREADY enforced CRON_SECRET (R40, U4) before this runs, so this handler only
// drives the tick — it adds no auth of its own (and must not, lest it second-guess the gate). It
// finds due steps under an atomic claim and runs the engine, fail-soft per contact, no double-send
// under overlapping ticks (R20, R21).
// =============================================================================================

/** Config for {@link createDripCronHandler}. */
export interface DripCronHandlerConfig {
  /** The root SDK handle (DB, Resend, agent, redaction). */
  envoy: Envoy;
  /**
   * How the tick resolves a sequence definition by key — a `Map` of `key → Sequence`, or a lookup
   * function. Sequence definitions live in host code (`defineSequence`), never in the DB, so the
   * host must register every sequence it runs. An enrollment whose key is not registered is skipped,
   * not dropped.
   */
  registry: SequenceRegistry;
  /** Engine config (consent mirror, unsubscribe base URL, stream, per-tick limit). */
  tick: DripTickConfig;
}

/**
 * Build the `/cron/drip` handler. Returns a {@link SubHandler} — `(request) => Promise<Response>` —
 * the host passes to `createEnvoyHandler({ ..., cron })`. The factory already gated the request on
 * `CRON_SECRET`; this handler runs one tick and returns a JSON summary (claimed/sent/skipped/failed).
 *
 * It NEVER throws to the caller: a claim/DB error is caught, redacted, logged, and surfaced as a 500
 * so the host's cron platform retries — but a single contact's failure inside the tick is already
 * fail-soft (R21) and reported in the body, not raised. A 2xx is returned even when some items
 * failed (they are left due and retried next tick); the body carries the breakdown for host alerting
 * (e.g. `lastFiredAt`-style health, R36 spirit).
 */
export function createDripCronHandler(
  config: DripCronHandlerConfig
): (request: Request) => Promise<Response> {
  const { envoy, registry, tick } = config;
  return async (_request: Request): Promise<Response> => {
    try {
      const result: DripTickResult = await tickDrip(envoy, registry, tick);
      return jsonResponse(200, {
        ok: true,
        claimed: result.claimed,
        sent: result.sent,
        skipped: result.skipped,
        failed: result.failed,
      });
    } catch (err) {
      // The claim or an un-caught tick-level error is OURS, not the caller's — surface 5xx so the
      // cron platform retries. Redact before logging (R43): no recipient/secret leaks.
      // eslint-disable-next-line no-console
      console.error(
        "[@envoy/sdk] drip cron tick failed:",
        envoy.redact(err instanceof Error ? err.message : String(err))
      );
      return jsonResponse(500, { ok: false, error: "tick_failed" });
    }
  };
}
