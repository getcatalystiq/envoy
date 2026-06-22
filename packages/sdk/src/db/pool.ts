import "server-only";

// Injected-pool wrapper + namespaced query helpers (U2 / origin R5, R38, R48, KTD6/KTD7).
//
// The SDK never opens its own connection. The host passes a `pg`-compatible pool
// (node-postgres `Pool`, a Neon `Pool`, or anything exposing `.query(text, params)`)
// into `createEnvoy({ db })`; this module is the only place the SDK talks to it.
//
// Two invariants this file enforces:
//   1. Success is derived from `rows.length`, never a driver `rowCount`. Neon's HTTP
//      driver does not populate `rowCount`, so reading it would silently report 0 rows
//      affected on a real write (see docs/solutions/2026-06-19-crm-lifecycle-sync-cas-gate.md).
//   2. Every logical key is namespace-prefixed (KTD7). Two installs sharing one Postgres
//      must never collide on a contact email, program key, or broadcast key. The prefix is
//      applied here, at the single DB boundary, so callers pass bare keys and cannot forget.

/**
 * Minimal structural shape of a `pg`-compatible query result. We only depend on `rows`
 * (and intentionally NOT on `rowCount` — see invariant 1). `T` is the row shape.
 */
export interface SdkQueryResult<T = Record<string, unknown>> {
  rows: T[];
}

/**
 * The host-supplied pool. Structurally compatible with node-postgres' `Pool` and Neon's
 * serverless `Pool` — both expose `query(text, params?) => Promise<{ rows }>`. We keep this
 * deliberately narrow so the SDK takes no hard dependency on a specific `pg` package
 * (the host owns the driver; the SDK ships no `pg` in its dependencies).
 */
export interface SdkPool {
  query<T = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>
  ): Promise<SdkQueryResult<T>>;
}

/**
 * Namespace separator. A real install namespace is fingerprint-checked in U3; here we only
 * require it be a non-empty string and contain no separator (so the prefix is unambiguous —
 * `a` + `b:c` and `a:b` + `c` must never produce the same key).
 */
const NS_SEP = ":";

/**
 * Canonicalize an email to the single casing every key-bearing path agrees on (lowercase, trimmed).
 *
 * Email addresses are case-insensitive in practice, but the SDK keys `sdk_contacts.email`,
 * `sdk_topic_consent.contact`, and `sdk_enrollments.contact` on the email verbatim — while the
 * webhook resolves with `lower(email)`. A mixed-case enrollment (`Mixed.Case@x.com`) therefore
 * never matched a lowercased webhook unsubscribe, and the gate read a different row than the one
 * the host wrote. Normalizing at the single boundary (enroll, consent.set, gate, and the webhook
 * resolve all call this) makes every path key on the same string, so suppression converges.
 *
 * A non-string / empty value is returned as the empty string; callers that require a non-empty
 * email validate that separately.
 */
export function normalizeEmail(email: string): string {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

/**
 * Validate an install namespace once, at wrapper construction. A blank or separator-bearing
 * namespace is a host-contract error and must fail loud (R38) rather than silently produce
 * keys that could alias another install's rows.
 */
function assertValidNamespace(namespace: string): void {
  if (typeof namespace !== "string" || namespace.length === 0) {
    throw new Error(
      "[@catalystiq/envoy-sdk] installNamespace must be a non-empty string (single-tenant guardrail, R38)."
    );
  }
  if (namespace.includes(NS_SEP)) {
    throw new Error(
      `[@catalystiq/envoy-sdk] installNamespace must not contain "${NS_SEP}" — it is the namespace key separator (R38).`
    );
  }
}

/**
 * A pool wrapper bound to one install namespace. All key-bearing writes/reads go through
 * `namespaceKey` so rows are isolated per install. Construct one with `createDb`.
 */
export class NamespacedDb {
  readonly namespace: string;
  private readonly pool: SdkPool;

  constructor(pool: SdkPool, namespace: string) {
    assertValidNamespace(namespace);
    this.pool = pool;
    this.namespace = namespace;
  }

  /**
   * Prefix a bare logical key with this install's namespace. The same bare key under two
   * different namespaces yields two distinct stored keys (KTD7). Callers store/read the
   * RESULT of this, never the bare key.
   */
  namespaceKey(key: string): string {
    if (typeof key !== "string" || key.length === 0) {
      throw new Error("[@catalystiq/envoy-sdk] key must be a non-empty string.");
    }
    return `${this.namespace}${NS_SEP}${key}`;
  }

  /**
   * Strip this install's namespace prefix off a stored key, returning the bare key. Throws if
   * the stored key belongs to a different namespace — a cross-namespace read is a fail-loud
   * condition (R38), not something to silently paper over.
   */
  stripNamespace(storedKey: string): string {
    const prefix = `${this.namespace}${NS_SEP}`;
    if (!storedKey.startsWith(prefix)) {
      throw new Error(
        `[@catalystiq/envoy-sdk] stored key does not belong to namespace "${this.namespace}" (R38 cross-namespace guard).`
      );
    }
    return storedKey.slice(prefix.length);
  }

  /**
   * Raw query passthrough. Returns the full result so callers can inspect `rows`. Use this for
   * SELECTs and for writes where you want the returned rows; prefer `execWrite` when you only
   * need "did it affect a row".
   */
  query<T = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>
  ): Promise<SdkQueryResult<T>> {
    return this.pool.query<T>(text, params);
  }

  /**
   * Run a write and report success from `rows.length` (invariant 1). The SQL MUST use
   * `RETURNING` so an effective write yields ≥1 row. Returns the affected count and rows.
   *
   * This is the canonical "did the write land" helper: a CAS gate / claim-on-conflict
   * (`INSERT … ON CONFLICT DO NOTHING RETURNING …`) returns 0 rows when it lost the race,
   * ≥1 when it won — derived from `rows.length`, never `rowCount`.
   */
  async execWrite<T = Record<string, unknown>>(
    text: string,
    params?: ReadonlyArray<unknown>
  ): Promise<{ count: number; rows: T[] }> {
    const result = await this.pool.query<T>(text, params);
    const rows = result.rows ?? [];
    return { count: rows.length, rows };
  }
}

/**
 * Construct a namespaced DB wrapper around a host-supplied pool. This is the single entry
 * point the rest of the SDK uses to reach Postgres.
 */
export function createDb(pool: SdkPool, namespace: string): NamespacedDb {
  return new NamespacedDb(pool, namespace);
}
