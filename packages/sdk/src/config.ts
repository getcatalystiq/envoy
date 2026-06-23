import "server-only";

import { createHash } from "node:crypto";

import { createDb, type NamespacedDb, type SdkPool } from "./db/pool.js";
import {
  createResendClientHandle,
  type ResendClientHandle,
} from "./resend/client.js";

// `createEnvoy` — the root handle (U3 / origin R3, R7, R24, R38, R43, R44, KTD7).
//
// Responsibilities, all at INIT time (so host-contract mistakes surface as init errors, never at
// send time — R45's "fail loud, not at send time" applied to config):
//   - Validate that the compliance-critical secrets are present (webhook/cron/unsubscribe) and
//     that the install namespace + base Segment are supplied.
//   - Intake the AI field allow-list (R44) and stream defaults, normalizing both.
//   - Build the lazy Resend client handle (R43; no-op when the key is unset).
//   - Fingerprint the install namespace into a `program_state`-adjacent sentinel row so two apps
//     that share one Postgres but reuse a namespace with different config fail loud (R38).
//
// Validation is hand-rolled rather than Zod-based on purpose: the SDK declares no `zod` dependency
// (it would be an undeclared transitive import), and the app's `lib/env.ts` Zod pattern is a
// *pattern to reimplement*, not a module to import (R48). The shape below mirrors `lib/env.ts`'s
// "validate-once, fail-loud, defaults applied" intent in plain TypeScript.

// ---------------------------------------------------------------------------------------------
// Public config shape
// ---------------------------------------------------------------------------------------------

/**
 * Managed-Agents configuration (R24). Agent id + environment are SDK-level config supplied by the
 * host from env secrets — never per-tenant DB state. Optional: a pure broadcast/digest host that
 * runs no AI drip lane needs none of it.
 */
export interface EnvoyAgentConfig {
  /** The Claude Managed Agent id that writes per-recipient drip copy. */
  agentId: string;
  /** The Managed-Agents environment id. */
  environmentId: string;
}

/**
 * Per-stream defaults. A "stream" is a type-of-email lane (e.g. `digest`, `alert`) — it scopes the
 * `List-Unsubscribe` token (R33/R46) and the Topic granularity (R27). The map keys are stream
 * names; for now the only declared default is the `from` address used when a send omits one.
 */
export interface EnvoyStreamConfig {
  /** Default From address for sends on this stream (host may still override per send). */
  from?: string;
}

/**
 * The config a host passes to `createEnvoy`. Secrets here originate from env (R43) and are never
 * logged or serialized by the SDK.
 */
export interface EnvoyConfig {
  /**
   * The host-supplied `pg`-compatible pool. The SDK never opens its own connection (R5); all DB
   * access goes through the namespaced wrapper built from this.
   */
  db: SdkPool;

  /**
   * Install namespace (R38/KTD7). Prefixes every program/subject/contact key and is
   * fingerprint-checked. A staging/prod split on one database is two namespaces (two installs).
   * Must be a non-empty string with no `:` (the namespace key separator).
   */
  installNamespace: string;

  /**
   * Resend API key (R43). Unlike the other secrets this is NOT required: when unset the Resend
   * client is a no-op (mirrors the app mailer; lets a host run in dev/CI without a key). Compliance
   * secrets below ARE required because an unset one is a silent compliance hole, not a dev no-op.
   */
  resendApiKey?: string;

  /** Svix/Resend webhook signing secret (R41). Required — an unset secret is an unverified webhook. */
  webhookSecret: string;
  /** Cron secret (R40). Required — an unset secret is an unauthenticated send + generation trigger. */
  cronSecret: string;
  /** Unsubscribe-token HMAC secret (R33). Required — an unset secret is an unsigned opt-out link. */
  unsubscribeSecret: string;

  /** The base Resend Segment id every enrolled contact joins (R10). Required broadcast target (R17). */
  baseSegmentId: string;

  /** Optional Managed-Agents config (R24). Omit for a host that runs no AI drip lane. */
  agent?: EnvoyAgentConfig;

  /**
   * Allow-list of contact `data` fields projected into the agent personalization payload (R44).
   * The SDK forwards ONLY these fields to Anthropic — never the whole mirror `data` verbatim.
   * Defaults to an empty list (forward nothing) so the safe default is the privacy-preserving one.
   */
  aiFieldAllowList?: string[];

  /** Per-stream defaults keyed by stream name (R33/R27). Optional. */
  streams?: Record<string, EnvoyStreamConfig>;

  /**
   * Allow-list of Resend Template ids permitted on the non-gated `system` transactional lane (KTD7).
   * `send.transactional({ system: true })` with a `templateId` NOT in this list throws
   * `SystemLaneViolation` — so a missed host-side check (or marketing copy passing `system: true`)
   * cannot ride the unsubscribe-less, marketing-consent-bypassing lane. Optional; defaults to empty
   * (no template is system-eligible, so each system send must opt its template in explicitly).
   */
  systemTemplateIds?: string[];
}

// ---------------------------------------------------------------------------------------------
// Resolved config (post-validation, defaults applied) + the handle
// ---------------------------------------------------------------------------------------------

/** The validated, normalized config the rest of the SDK reads. Secrets are present but the handle
 * that wraps this never serializes them (see `Envoy.toJSON`). */
export interface ResolvedEnvoyConfig {
  installNamespace: string;
  resendApiKey?: string;
  webhookSecret: string;
  cronSecret: string;
  unsubscribeSecret: string;
  baseSegmentId: string;
  agent?: EnvoyAgentConfig;
  /** Frozen, de-duplicated allow-list. Empty array = forward nothing. */
  aiFieldAllowList: readonly string[];
  /** Frozen stream-defaults map (empty object when none supplied). */
  streams: Readonly<Record<string, EnvoyStreamConfig>>;
  /** Frozen set of Template ids eligible for the `system` transactional lane (KTD7). Empty = none. */
  systemTemplateIds: ReadonlySet<string>;
}

/**
 * The root SDK handle returned by `createEnvoy`. Later units hang their server functions off this
 * (enroll, sequences, broadcast, send.transactional, …). U3 ships the foundation: the resolved
 * config, the namespaced DB, the lazy Resend handle, the namespace guard, and the redaction helper.
 */
export interface Envoy {
  /** Validated config (defaults applied). Reading secrets off this is intentional for internal
   * units; the handle's own `toJSON`/inspect output redacts them. */
  readonly config: ResolvedEnvoyConfig;
  /** Namespaced DB wrapper bound to `installNamespace`. The single DB boundary for the SDK. */
  readonly db: NamespacedDb;
  /** Lazy Resend client handle (no-op when `resendApiKey` is unset). */
  readonly resend: ResendClientHandle;

  /**
   * Verify (and, on first run, write) this install's namespace fingerprint in the host DB (R38).
   * Idempotent: re-running with the same namespace + identity is a no-op; a namespace already
   * fingerprinted with a DIFFERENT config identity throws (another install detected). Call this
   * from the host's init/deploy step; SDK server fns also call it lazily before first DB write.
   */
  assertNamespaceFingerprint(): Promise<void>;

  /**
   * Redact a secret-bearing or PII-bearing string for logs (R43). Emails are reduced to a
   * non-reversible hint (`a***@example.com`); any other value is fully masked. Never returns the
   * original. Use this at every log site that might otherwise emit a secret or full address.
   */
  redact(value: unknown): string;
}

// ---------------------------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------------------------

/** A configuration error thrown by `createEnvoy` at INIT time. Carries no secret values. */
export class EnvoyConfigError extends Error {
  constructor(message: string) {
    super(`[@catalystiq/envoy-sdk] ${message}`);
    this.name = "EnvoyConfigError";
  }
}

/** Thrown by `assertNamespaceFingerprint` when the host DB is already owned by an install whose
 * config identity differs from this one (R38 cross-install guard). */
export class EnvoyNamespaceError extends Error {
  constructor(message: string) {
    super(`[@catalystiq/envoy-sdk] ${message}`);
    this.name = "EnvoyNamespaceError";
  }
}

// ---------------------------------------------------------------------------------------------
// Redaction helpers (R43)
// ---------------------------------------------------------------------------------------------

/**
 * Reduce an email to a non-reversible hint for logs: `marko@example.com` -> `m***@example.com`.
 * A malformed / non-email string is fully masked. No full local-part ever appears (R43: "no full
 * email addresses … appear in logs").
 */
export function redactEmail(value: string): string {
  const at = value.indexOf("@");
  if (at <= 0) return "***";
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (domain.length === 0) return "***";
  const head = local[0] ?? "";
  return `${head}***@${domain}`;
}

/** Fully mask any value (secrets, tokens). Returns a fixed sentinel — never the input length or
 * any prefix, so nothing about the secret leaks. */
function maskSecret(): string {
  return "***";
}

/**
 * Best-effort redaction for an arbitrary log value. If it looks like an email, hint it; otherwise
 * mask it entirely. This is intentionally conservative — when in doubt, mask.
 */
export function redactValue(value: unknown): string {
  if (typeof value !== "string") return maskSecret();
  if (value.includes("@") && value.indexOf("@") > 0) return redactEmail(value);
  return maskSecret();
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function requireNonEmptyString(
  value: unknown,
  field: string
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new EnvoyConfigError(
      `${field} is required and must be a non-empty string (set it at createEnvoy time, not at send time).`
    );
  }
  return value;
}

/** Normalize the AI field allow-list: must be string entries, de-duplicated, frozen (R44). */
function normalizeAllowList(input: string[] | undefined): readonly string[] {
  if (input === undefined) return Object.freeze([]);
  if (!Array.isArray(input)) {
    throw new EnvoyConfigError("aiFieldAllowList must be an array of field names.");
  }
  const seen = new Set<string>();
  for (const f of input) {
    if (typeof f !== "string" || f.length === 0) {
      throw new EnvoyConfigError(
        "aiFieldAllowList entries must be non-empty strings (contact data field names)."
      );
    }
    seen.add(f);
  }
  return Object.freeze([...seen]);
}

function normalizeStreams(
  input: Record<string, EnvoyStreamConfig> | undefined
): Readonly<Record<string, EnvoyStreamConfig>> {
  if (input === undefined) return Object.freeze({});
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new EnvoyConfigError("streams must be a record of stream name -> stream config.");
  }
  const out: Record<string, EnvoyStreamConfig> = {};
  for (const [name, cfg] of Object.entries(input)) {
    if (name.length === 0) {
      throw new EnvoyConfigError("a stream name must be a non-empty string.");
    }
    if (cfg.from !== undefined && typeof cfg.from !== "string") {
      throw new EnvoyConfigError(`streams.${name}.from must be a string when provided.`);
    }
    out[name] = Object.freeze({ ...cfg });
  }
  return Object.freeze(out);
}

/**
 * Normalize the `system` transactional lane allow-list (KTD7): string Template ids, de-duplicated,
 * into a Set the sender checks at send time. Empty/undefined ⇒ an empty set, so no template is
 * system-eligible until the host opts it in explicitly.
 */
function normalizeSystemTemplateIds(input: string[] | undefined): ReadonlySet<string> {
  if (input === undefined) return new Set<string>();
  if (!Array.isArray(input)) {
    throw new EnvoyConfigError("systemTemplateIds must be an array of Resend Template ids.");
  }
  const set = new Set<string>();
  for (const id of input) {
    if (typeof id !== "string" || id.trim().length === 0) {
      throw new EnvoyConfigError(
        "systemTemplateIds entries must be non-empty strings (Resend Template ids)."
      );
    }
    set.add(id);
  }
  return set;
}

function normalizeAgent(input: EnvoyAgentConfig | undefined): EnvoyAgentConfig | undefined {
  if (input === undefined) return undefined;
  // If the host provides an `agent` block at all, both fields are required — a half-configured
  // agent is a fail-loud init error, not a runtime surprise.
  const agentId = requireNonEmptyString(input.agentId, "agent.agentId");
  const environmentId = requireNonEmptyString(input.environmentId, "agent.environmentId");
  return Object.freeze({ agentId, environmentId });
}

/**
 * Validate + normalize raw host config into a resolved config. Throws `EnvoyConfigError` on the
 * first problem. Pure (no I/O) so config errors are guaranteed to precede any DB/Resend contact.
 */
export function resolveConfig(cfg: EnvoyConfig): ResolvedEnvoyConfig {
  if (cfg === null || typeof cfg !== "object") {
    throw new EnvoyConfigError("createEnvoy(config) requires a config object.");
  }
  if (cfg.db === null || typeof cfg.db !== "object" || typeof cfg.db.query !== "function") {
    throw new EnvoyConfigError(
      "config.db must be a pg-compatible pool exposing query(text, params)."
    );
  }

  // installNamespace is validated structurally here AND again by NamespacedDb (which also rejects
  // the `:` separator). We surface the missing-field message first so the host sees the right field.
  requireNonEmptyString(cfg.installNamespace, "installNamespace");

  // Compliance-critical secrets: required, fail loud at init (NOT at send time).
  const webhookSecret = requireNonEmptyString(cfg.webhookSecret, "webhookSecret");
  const cronSecret = requireNonEmptyString(cfg.cronSecret, "cronSecret");
  const unsubscribeSecret = requireNonEmptyString(cfg.unsubscribeSecret, "unsubscribeSecret");
  const baseSegmentId = requireNonEmptyString(cfg.baseSegmentId, "baseSegmentId");

  // resendApiKey is deliberately optional (no-op when unset, R43) — validated only if present.
  let resendApiKey: string | undefined;
  if (cfg.resendApiKey !== undefined) {
    if (typeof cfg.resendApiKey !== "string") {
      throw new EnvoyConfigError("resendApiKey must be a string when provided.");
    }
    const trimmed = cfg.resendApiKey.trim();
    resendApiKey = trimmed.length > 0 ? trimmed : undefined;
  }

  return Object.freeze({
    installNamespace: cfg.installNamespace,
    resendApiKey,
    webhookSecret,
    cronSecret,
    unsubscribeSecret,
    baseSegmentId,
    agent: normalizeAgent(cfg.agent),
    aiFieldAllowList: normalizeAllowList(cfg.aiFieldAllowList),
    streams: normalizeStreams(cfg.streams),
    systemTemplateIds: normalizeSystemTemplateIds(cfg.systemTemplateIds),
  });
}

// ---------------------------------------------------------------------------------------------
// Namespace fingerprint (R38)
// ---------------------------------------------------------------------------------------------

// The fingerprint sentinel lives in `sdk_program_state` (no schema change — "a program_state-
// adjacent row" per the unit spec) under reserved program/subject keys that no real program can
// collide with (a `:`-bearing key is impossible via `namespaceKey`, which forbids the separator,
// but these are written to the raw columns directly, not via namespaceKey).
const FINGERPRINT_PROGRAM_KEY = "__envoy_install__";
const FINGERPRINT_SUBJECT_KEY = "__fingerprint__";

/**
 * Derive the install's config-identity fingerprint. It is a hash of the namespace and the stable,
 * non-secret config identity (`baseSegmentId`) — NOT of any secret (so the stored value leaks
 * nothing). Two installs that (mis)use the same namespace but target different base Segments produce
 * different fingerprints and trip the guard; the same install re-running produces the same value
 * (idempotent). Secrets are intentionally excluded: rotating a key must not trip the guard.
 */
export function computeNamespaceFingerprint(config: ResolvedEnvoyConfig): string {
  const identity = `${config.installNamespace} ${config.baseSegmentId}`;
  return createHash("sha256").update(identity).digest("hex");
}

/**
 * Write-or-verify the fingerprint sentinel for this install. Uses the claim-on-conflict idiom from
 * `lib/queries/system.ts` / the CAS-gate learning: an `INSERT … ON CONFLICT DO NOTHING RETURNING`
 * either wins (first install — sentinel written) or loses (sentinel already present), in which case
 * we read the stored value and compare. A mismatch is a fail-loud cross-install collision (R38).
 */
async function assertNamespaceFingerprint(
  db: NamespacedDb,
  config: ResolvedEnvoyConfig
): Promise<void> {
  const fingerprint = computeNamespaceFingerprint(config);

  // Try to claim the sentinel row. Success is derived from rows.length (never a driver rowCount),
  // matching the DB wrapper's invariant.
  const claim = await db.execWrite<{ watermark: string | null }>(
    `INSERT INTO sdk_program_state (namespace, program_key, subject_key, watermark)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (namespace, program_key, subject_key) DO NOTHING
     RETURNING watermark`,
    [db.namespace, FINGERPRINT_PROGRAM_KEY, FINGERPRINT_SUBJECT_KEY, fingerprint]
  );

  if (claim.count > 0) {
    // First install under this namespace — sentinel just written, nothing to compare.
    return;
  }

  // Sentinel already exists: read it and compare. A missing row here would be a race we lost then
  // the row vanished — treat an absent/blank stored value as unverifiable and fail loud.
  const existing = await db.query<{ watermark: string | null }>(
    `SELECT watermark FROM sdk_program_state
     WHERE namespace = $1 AND program_key = $2 AND subject_key = $3`,
    [db.namespace, FINGERPRINT_PROGRAM_KEY, FINGERPRINT_SUBJECT_KEY]
  );

  const stored = existing.rows[0]?.watermark;
  if (typeof stored !== "string" || stored.length === 0) {
    throw new EnvoyNamespaceError(
      `namespace "${db.namespace}" has a fingerprint sentinel row with no value — refusing to proceed (R38). ` +
        `This database may be in an inconsistent state from a partial install.`
    );
  }
  if (stored !== fingerprint) {
    throw new EnvoyNamespaceError(
      `namespace "${db.namespace}" is already owned by a different @catalystiq/envoy-sdk install ` +
        `(stored fingerprint does not match this config). Two installs must not share a namespace — ` +
        `use a distinct installNamespace per logical install (R38).`
    );
  }
  // Match — idempotent re-run, nothing to do.
}

// ---------------------------------------------------------------------------------------------
// createEnvoy
// ---------------------------------------------------------------------------------------------

/**
 * Build the root SDK handle. Validates config synchronously (errors thrown here, never at send
 * time). The namespace fingerprint is checked lazily — the first `assertNamespaceFingerprint()`
 * call performs the DB write/verify and memoizes the result, so repeated calls cost one round trip.
 */
export function createEnvoy(cfg: EnvoyConfig): Envoy {
  const config = resolveConfig(cfg);
  const db = createDb(cfg.db, config.installNamespace);
  const resend = createResendClientHandle(config.resendApiKey);

  // Memoize the fingerprint check so server fns can call it freely before a write without paying a
  // round trip every time. A rejected promise is NOT cached — a transient DB error should be
  // retryable on the next call rather than poisoning the handle forever.
  let fingerprintPromise: Promise<void> | null = null;

  const handle: Envoy = {
    config,
    db,
    resend,
    assertNamespaceFingerprint(): Promise<void> {
      if (fingerprintPromise === null) {
        fingerprintPromise = assertNamespaceFingerprint(db, config).catch((err) => {
          fingerprintPromise = null; // allow retry on transient failure
          throw err;
        });
      }
      return fingerprintPromise;
    },
    redact(value: unknown): string {
      return redactValue(value);
    },
  };

  // `toJSON` / inspection must never leak secrets (R43). Defining it non-enumerable keeps it off
  // normal property iteration while still being picked up by JSON.stringify and util.inspect.
  Object.defineProperty(handle, "toJSON", {
    enumerable: false,
    value(): Record<string, unknown> {
      return {
        installNamespace: config.installNamespace,
        baseSegmentId: config.baseSegmentId,
        resendEnabled: resend.enabled,
        agentConfigured: config.agent !== undefined,
        aiFieldAllowList: config.aiFieldAllowList,
        streams: Object.keys(config.streams),
        // secrets intentionally omitted
      };
    },
  });

  return handle;
}
