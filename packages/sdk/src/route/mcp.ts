import "server-only";

import { createMcpHandler, withMcpAuth } from "mcp-handler";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { z } from "zod";

import type { Envoy } from "../config.js";
import { secretsMatch, type SubHandler } from "./handler.js";
import { createConsentMirror, type Stream } from "../consent/mirror.js";
import { enroll, deleteContact, type SyncTopic } from "../contacts.js";
import type { Sequence } from "../drip/sequence.js";
import type { BroadcastProgram, RunIssueResult } from "../broadcast/program.js";
import { read as readCursor } from "../broadcast/cursor.js";

// MCP endpoint (authed) — re-pointed at the SDK internals so an AI agent can operate the full
// lifecycle (U16 / origin R25, R42). This is the primary "management" surface given the headless
// decision: no admin UI ships, so the MCP server + the read-only hooks (U17) are how a host (or its
// agent) observes and drives Envoy.
//
// The endpoint is constructed internally via `createMcpHandler` + `withMcpAuth` — the SAME stack the
// app uses in `app/mcp/route.ts` — and returns a Web-standard `(Request) => Promise<Response>`
// (`SubHandler`), so it stays App-Router compatible and is wired into the mounted catch-all as
// `createEnvoyHandler({ ..., mcp: createMcpRouteHandler({ envoy, mcpSecret, ... }) })`.
//
// AUTH — TWO INDEPENDENT GATES, NEVER OPEN (R42):
//   1. The route factory (U4) already gates `/mcp` with a constant-time `mcpSecret` compare before it
//      ever calls this handler. That is the outer, authoritative gate.
//   2. This module ALSO wraps the MCP handler with `withMcpAuth({ required: true })`, verifying the
//      same dedicated credential. So even mounted standalone (bypassing U4), the MCP server itself
//      rejects an unauthenticated call — an open MCP endpoint is an open admin API over the contact
//      mirror, so it fails closed on an unset/empty/missing credential.
//
// SINGLE-TENANT TRIM (vs the app's 15-tool, `organization_id`-scoped surface): there is no tenant
// column and no `getAuth(tenantId)` — one install is one tenant (R7). Sequences and programs are
// HOST CODE definitions (`defineSequence` / `defineBroadcastProgram`), never DB rows, so the host
// registers the ones an agent may operate; an unregistered key is reported, never invented.
//
// SUPPRESSION IS HONORED AT THE TOOL BOUNDARY (the unit's edge case): every write goes through the
// same server fns the host calls (`enroll`, `runIssue`, `consentMirror.set`), so the suppression
// mirror gates exactly as it does elsewhere — `enroll` reports `suppressed` and skips the Resend
// sync for a globally-unsubscribed contact, and `runIssue` runs the pre-send reconcile + per-topic
// gate. The MCP layer adds no bypass.

// ---------------------------------------------------------------------------------------------
// Registries (host code, not DB)
// ---------------------------------------------------------------------------------------------

/** Resolve a {@link Sequence} by key — a `Map` of `key → Sequence`, or a lookup function. Mirrors
 *  the drip cron's `SequenceRegistry` so the same host registration drives both surfaces. */
export type McpSequenceRegistry =
  | ReadonlyMap<string, Sequence>
  | ((key: string) => Sequence | undefined);

/** Resolve a {@link BroadcastProgram} by key — a `Map`, or a lookup function. */
export type McpProgramRegistry =
  | ReadonlyMap<string, BroadcastProgram>
  | ((key: string) => BroadcastProgram | undefined);

function resolveSequence(
  registry: McpSequenceRegistry | undefined,
  key: string
): Sequence | undefined {
  if (registry === undefined) return undefined;
  return typeof registry === "function" ? registry(key) : registry.get(key);
}

function resolveProgram(
  registry: McpProgramRegistry | undefined,
  key: string
): BroadcastProgram | undefined {
  if (registry === undefined) return undefined;
  return typeof registry === "function" ? registry(key) : registry.get(key);
}

function listKeys<V>(
  registry: ReadonlyMap<string, V> | ((key: string) => V | undefined) | undefined
): string[] | null {
  if (registry === undefined) return [];
  // A function registry cannot be enumerated — report `null` so the tool says "lookup-only".
  if (typeof registry === "function") return null;
  return Array.from(registry.keys());
}

// ---------------------------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------------------------

/**
 * Verify an MCP bearer token, returning an {@link AuthInfo} when valid or `undefined` to reject.
 * The default ({@link defaultVerifyMcpToken}) is a constant-time compare against the configured
 * `mcpSecret`; a host that wants its `authorize(req)` to recognize an agent token can inject its own.
 */
export type McpVerifyToken = (
  request: Request,
  bearerToken: string | undefined
) => AuthInfo | undefined | Promise<AuthInfo | undefined>;

/** Config for {@link createMcpRouteHandler}. */
export interface McpRouteConfig {
  /** The root SDK handle (DB, Resend, agent, redaction). */
  envoy: Envoy;
  /**
   * The dedicated MCP credential (R42). Used by the default token verifier. The route factory (U4)
   * also gates `/mcp` against this; this module re-checks it so a standalone mount is never open.
   * When omitted (and no custom `verifyToken`), the MCP handler fails closed (every call rejected).
   */
  mcpSecret?: string;
  /** Custom token verifier (overrides the default constant-time `mcpSecret` compare). */
  verifyToken?: McpVerifyToken;
  /** Sequences an agent may enroll into / inspect (host `defineSequence` definitions). */
  sequences?: McpSequenceRegistry;
  /** Broadcast programs an agent may trigger / inspect (host `defineBroadcastProgram` handles). */
  programs?: McpProgramRegistry;
  /** Absolute https landing URL the drip List-Unsubscribe header points at — passed through for
   *  parity with the engine config; unused by the current read/enroll tools. */
  unsubscribeBaseUrl?: string;
  /** Max MCP request duration (seconds). Mirrors the app's `{ maxDuration: 60 }`. */
  maxDuration?: number;
}

// ---------------------------------------------------------------------------------------------
// Constant-time secret compare — shared with the route factory (imported from ./handler.js so the
// MCP credential check and the cron/factory checks run the SAME audited timing-safe compare).
// ---------------------------------------------------------------------------------------------

/**
 * The default MCP token verifier: a constant-time compare of the bearer token against `mcpSecret`.
 * Returns an {@link AuthInfo} on a match, `undefined` otherwise. An unset/empty `mcpSecret` or a
 * missing bearer token always rejects (never open, R42).
 */
export function defaultVerifyMcpToken(
  mcpSecret: string | undefined
): McpVerifyToken {
  const expected = typeof mcpSecret === "string" ? mcpSecret : "";
  return (_request, bearerToken) => {
    if (typeof bearerToken !== "string" || bearerToken.length === 0) return undefined;
    if (!secretsMatch(bearerToken, expected)) return undefined;
    const info: AuthInfo = {
      token: bearerToken,
      clientId: "envoy-mcp",
      scopes: ["write"],
    };
    return info;
  };
}

// ---------------------------------------------------------------------------------------------
// Tool result helpers
// ---------------------------------------------------------------------------------------------

function textResult(text: string, structured?: Record<string, unknown>) {
  const result: {
    content: { type: "text"; text: string }[];
    structuredContent?: Record<string, unknown>;
  } = { content: [{ type: "text", text }] };
  if (structured !== undefined) result.structuredContent = structured;
  return result;
}

function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: `Error: ${message}` }],
    isError: true,
  };
}

const STREAM_ENUM = z.enum(["digest", "alert"]);

// ---------------------------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------------------------

/**
 * Register the single-tenant lifecycle tools on an {@link McpServer}. Exposed standalone (in addition
 * to being wired by {@link createMcpRouteHandler}) so a host that builds its own MCP server can reuse
 * the exact tool set, and so tests can register against an in-memory server.
 *
 * Every tool that WRITES goes through the same server fn the host calls directly, so the suppression
 * mirror, the send-once claim, and the per-topic consent gate all apply unchanged.
 */
export function registerEnvoyTools(server: McpServer, config: McpRouteConfig): void {
  const { envoy } = config;

  // The consent mirror is bound to one install's DB + Resend handle and is stateless across reads —
  // construct it ONCE here and close over it, rather than re-instantiating per get_consent call.
  const consentMirror = createConsentMirror(envoy.db, envoy.resend);

  // --- enroll_contact (write) — event-driven enrollment (R8/R10/R11). Suppression-honoring: a
  //     globally-unsubscribed contact records the enrollment but is NOT re-synced to Resend, and the
  //     result reports `suppressed: true`. -------------------------------------------------------
  server.registerTool(
    "enroll_contact",
    {
      description:
        "Enroll a contact into a drip sequence (idempotent; a re-enroll of an active contact is a " +
        "no-op). A globally-suppressed contact is recorded but not re-synced and no email is sent.",
      inputSchema: {
        email: z.string().email().describe("Recipient email."),
        sequenceKey: z.string().min(1).describe("The sequence to enroll into."),
        data: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Arbitrary host JSON mirrored on the contact (personalization inputs)."),
        topicStream: STREAM_ENUM.optional().describe(
          "Stream of the topic to reflect for this enrollment (defaults: no topic push)."
        ),
        topicSubject: z
          .string()
          .min(1)
          .optional()
          .describe("Subject of the topic to provision + opt-in (paired with topicStream)."),
      },
    },
    async (args) => {
      try {
        let topic: SyncTopic | undefined;
        if (args.topicStream && args.topicSubject) {
          topic = { stream: args.topicStream as Stream, subject: args.topicSubject };
        }
        const result = await enroll(
          envoy,
          { email: args.email, data: args.data },
          args.sequenceKey,
          topic ? { topic } : {}
        );
        const note = result.suppressed
          ? "suppressed (recorded, not synced, nothing sent)"
          : result.created
            ? "enrolled"
            : "already active (no-op)";
        return textResult(`Contact ${note} in sequence "${result.sequenceKey}".`, {
          sequenceKey: result.sequenceKey,
          status: result.status,
          created: result.created,
          suppressed: result.suppressed,
          syncOk: result.sync?.ok ?? null,
          syncDirty: result.sync?.dirty ?? null,
        });
      } catch (err) {
        return errorResult(envoy.redact(err instanceof Error ? err.message : String(err)));
      }
    }
  );

  // --- list_sequences (read) ------------------------------------------------------------------
  server.registerTool(
    "list_sequences",
    {
      description:
        "List the drip sequence keys registered for this install (host `defineSequence` definitions).",
      inputSchema: {},
    },
    async () => {
      const keys = listKeys(config.sequences);
      if (keys === null) {
        return textResult(
          "Sequences are resolved by a lookup function and cannot be enumerated; inspect a known key with get_sequence.",
          { enumerable: false }
        );
      }
      return textResult(`${keys.length} sequence(s) registered.`, { sequences: keys });
    }
  );

  // --- get_sequence (read) --------------------------------------------------------------------
  server.registerTool(
    "get_sequence",
    {
      description: "Inspect one drip sequence's steps (template, wait, AI slots, brief) by key.",
      inputSchema: { key: z.string().min(1) },
    },
    async (args) => {
      const sequence = resolveSequence(config.sequences, args.key);
      if (!sequence) {
        return errorResult(`sequence "${args.key}" is not registered.`);
      }
      const steps = sequence.steps.map((s, i) => ({
        index: i,
        templateId: s.templateId,
        waitDays: s.waitDays,
        aiSlots: [...s.aiSlots],
        brief: s.brief,
      }));
      return textResult(`Sequence "${sequence.key}" has ${steps.length} step(s).`, {
        key: sequence.key,
        steps,
      });
    }
  );

  // --- list_programs (read) -------------------------------------------------------------------
  server.registerTool(
    "list_programs",
    {
      description: "List the broadcast program keys registered for this install.",
      inputSchema: {},
    },
    async () => {
      const keys = listKeys(config.programs);
      if (keys === null) {
        return textResult(
          "Programs are resolved by a lookup function and cannot be enumerated; inspect a known key with get_program.",
          { enumerable: false }
        );
      }
      return textResult(`${keys.length} program(s) registered.`, { programs: keys });
    }
  );

  // --- get_program (read) ---------------------------------------------------------------------
  server.registerTool(
    "get_program",
    {
      description: "Inspect one broadcast program's config (segment, cadence, from) by key.",
      inputSchema: { key: z.string().min(1) },
    },
    async (args) => {
      const program = resolveProgram(config.programs, args.key);
      if (!program) {
        return errorResult(`program "${args.key}" is not registered.`);
      }
      return textResult(`Program "${program.key}".`, {
        key: program.key,
        segmentId: program.segmentId,
        cadenceDays: program.cadenceDays,
        from: program.from ?? null,
      });
    }
  );

  // --- get_program_state (read) — the cursor watermark/issueSeq/lastFiredAt health signal (R36). -
  server.registerTool(
    "get_program_state",
    {
      description:
        "Read a broadcast program's cursor state for a subject (watermark, issue sequence, " +
        "lastFiredAt health signal, paused).",
      inputSchema: {
        programKey: z.string().min(1),
        subjectKey: z.string().min(1).default("default"),
      },
    },
    async (args) => {
      try {
        const state = await readCursor(envoy.db, {
          programKey: args.programKey,
          subjectKey: args.subjectKey,
        });
        return textResult(
          `Cursor for "${args.programKey}" / "${args.subjectKey}": issue ${state.issueSeq}.`,
          {
            programKey: args.programKey,
            subjectKey: args.subjectKey,
            watermark: state.watermark,
            issueSeq: state.issueSeq,
            lastFiredAt: state.lastFiredAt,
            paused: state.paused,
          }
        );
      } catch (err) {
        return errorResult(envoy.redact(err instanceof Error ? err.message : String(err)));
      }
    }
  );

  // --- get_consent (read) — the authoritative send-gate mirror for a contact+topic. ------------
  server.registerTool(
    "get_consent",
    {
      description:
        "Read the per-topic consent mirror row for a contact (the authoritative send gate). " +
        "Returns whether each stream may send.",
      inputSchema: {
        email: z.string().email(),
        topicKey: z.string().min(1),
      },
    },
    async (args) => {
      try {
        const row = await consentMirror.read(args.email, args.topicKey);
        if (row === null) {
          return textResult(
            `No consent row for this contact + topic (deny-by-default; the topic was never provisioned).`,
            { found: false, digest: null, alert: null }
          );
        }
        return textResult(`Consent: digest=${row.digest}, alert=${row.alert}.`, {
          found: true,
          digest: row.digest,
          alert: row.alert,
        });
      } catch (err) {
        return errorResult(envoy.redact(err instanceof Error ? err.message : String(err)));
      }
    }
  );

  // --- run_broadcast_issue (write) — trigger ONE issue of a program for ONE subject. Runs the
  //     canonical reconcile → claim → render → send → advance ordering (per-subject fail-soft); the
  //     send-once claim + reconcile gate suppression exactly as the host path does. ---------------
  server.registerTool(
    "run_broadcast_issue",
    {
      description:
        "Trigger one issue of a broadcast program for one subject (reconcile → claim → render → " +
        "send → advance). Per-subject fail-soft; the send-once claim prevents a double-send.",
      inputSchema: {
        programKey: z.string().min(1),
        subjectKey: z.string().min(1).default("default"),
        force: z
          .boolean()
          .optional()
          .describe("Bypass the cadence timer (the send-once claim still guards a double-send)."),
      },
    },
    async (args) => {
      const program = resolveProgram(config.programs, args.programKey);
      if (!program) {
        return errorResult(`program "${args.programKey}" is not registered.`);
      }
      let result: RunIssueResult;
      try {
        result = await program.runIssue(envoy, {
          subjectKey: args.subjectKey,
          ...(args.force !== undefined ? { force: args.force } : {}),
        });
      } catch (err) {
        return errorResult(envoy.redact(err instanceof Error ? err.message : String(err)));
      }
      const summary = result.sent
        ? `sent (broadcast ${result.broadcastId ?? "?"})`
        : result.skipped
          ? `skipped (${result.skipped})`
          : result.failed
            ? `failed (${result.failed})`
            : "no-op";
      return textResult(`Issue for "${result.programKey}" / "${result.subjectKey}": ${summary}.`, {
        programKey: result.programKey,
        subjectKey: result.subjectKey,
        sent: result.sent,
        broadcastId: result.broadcastId ?? null,
        skipped: result.skipped ?? null,
        failed: result.failed ?? null,
      });
    }
  );

  // --- delete_contact (write) — right-to-erasure (R34). Suppress-before-delete; fail-soft. -------
  server.registerTool(
    "delete_contact",
    {
      description:
        "Right-to-erasure: suppress the contact in the mirror FIRST, then best-effort delete the " +
        "Resend Contact + Segment/Topic membership (fail-soft).",
      inputSchema: { email: z.string().email() },
    },
    async (args) => {
      try {
        const result = await deleteContact(envoy, args.email);
        return textResult(`Contact suppressed; Resend teardown attempted.`, {
          suppressed: result.suppressed,
          resendContactDeleted: result.resendContactDeleted,
          segmentMembershipRemoved: result.segmentMembershipRemoved,
          topicMembershipCleared: result.topicMembershipCleared,
        });
      } catch (err) {
        return errorResult(envoy.redact(err instanceof Error ? err.message : String(err)));
      }
    }
  );
}

// ---------------------------------------------------------------------------------------------
// Server instructions
// ---------------------------------------------------------------------------------------------

/** Instructions surfaced to the connecting agent (the app's `SERVER_INSTRUCTIONS`, single-tenant). */
export const SERVER_INSTRUCTIONS =
  "You operate one Envoy install (single tenant). You can enroll contacts into drip sequences, " +
  "inspect sequences and broadcast programs, read program cursor state and per-topic consent, " +
  "trigger a broadcast issue, and erase a contact. Every send honors the suppression mirror: a " +
  "suppressed contact is never mailed. Sequences and programs are host-defined; you can only " +
  "operate the ones the host registered.";

// ---------------------------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------------------------

const MCP_ENDPOINT = "/mcp";

/**
 * Rewrite an incoming request so its pathname is exactly `/mcp` (the endpoint `mcp-handler` matches
 * against). The route factory mounts the catch-all at an arbitrary base (`/api/envoy/mcp`, `/envoy/
 * mcp`, …), so the raw `request.url` pathname would NOT exact-match `mcp-handler`'s default endpoint
 * and would 404. We canonicalize the path here, preserving the query string, method, headers, body,
 * and abort signal. (We never know the mount base at config time — the factory is mount-agnostic —
 * so the rewrite must happen per request.)
 */
function canonicalizeMcpRequest(request: Request): Request {
  const url = new URL(request.url);
  if (url.pathname === MCP_ENDPOINT) return request;
  const canonical = new URL(MCP_ENDPOINT + url.search, url.origin);
  const init: RequestInit = {
    method: request.method,
    headers: request.headers,
    signal: request.signal,
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    // Stream the original body through. `duplex` is required by the Fetch spec when a body is set.
    init.body = request.body;
    (init as RequestInit & { duplex: "half" }).duplex = "half";
  }
  return new Request(canonical.toString(), init);
}

/**
 * Build the `/mcp` {@link SubHandler}. Constructs the MCP server with `createMcpHandler`, registers
 * the single-tenant lifecycle tools, and wraps it with `withMcpAuth({ required: true })` so the MCP
 * server itself is never open (R42) — independent of the route factory's outer `mcpSecret` gate.
 *
 * Returns a Web-standard `(Request) => Promise<Response>`, so it slots directly into
 * `createEnvoyHandler({ ..., mcp })` and stays App-Router compatible.
 */
export function createMcpRouteHandler(config: McpRouteConfig): SubHandler {
  if (config === null || typeof config !== "object") {
    throw new TypeError("[@envoy/sdk] createMcpRouteHandler(config) requires a config object.");
  }
  if (config.envoy === null || typeof config.envoy !== "object") {
    throw new TypeError("[@envoy/sdk] createMcpRouteHandler requires an `envoy` handle.");
  }

  const handler = createMcpHandler(
    (server) => {
      registerEnvoyTools(server, config);
    },
    { instructions: SERVER_INSTRUCTIONS },
    { maxDuration: config.maxDuration ?? 60 }
  );

  const verify = config.verifyToken ?? defaultVerifyMcpToken(config.mcpSecret);
  const authedHandler = withMcpAuth(handler, verify, { required: true });

  return (request: Request): Promise<Response> => authedHandler(canonicalizeMcpRequest(request));
}

/** Alias matching the app's `createMcpHandler` naming, for hosts that build their own MCP server. */
export { createMcpRouteHandler as createEnvoyMcpHandler };
