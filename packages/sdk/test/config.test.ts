import { describe, expect, it, vi } from "vitest";

import {
  createEnvoy,
  resolveConfig,
  computeNamespaceFingerprint,
  redactEmail,
  redactValue,
  EnvoyConfigError,
  EnvoyNamespaceError,
  type EnvoyConfig,
} from "@sdk/config.js";
import type { SdkPool, SdkQueryResult } from "@sdk/db/pool.js";
import { createResendClientHandle } from "@sdk/resend/client.js";

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

/**
 * A fake pool that models the fingerprint sentinel in `sdk_program_state`. It implements just the
 * two statements `assertNamespaceFingerprint` runs:
 *   - `INSERT … ON CONFLICT DO NOTHING RETURNING watermark` (claim) — returns the row only if the
 *     (namespace, program_key, subject_key) tuple was previously absent.
 *   - `SELECT watermark …` — returns the stored sentinel for that tuple.
 * No real DB. Records every (text, params) for assertions.
 */
function fakeFingerprintPool() {
  const store = new Map<string, string>(); // key -> watermark
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];

  const key = (params: ReadonlyArray<unknown>) =>
    `${params[0]}|${params[1]}|${params[2]}`;

  const query = vi.fn(
    async <T = Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>
    ): Promise<SdkQueryResult<T>> => {
      calls.push({ text, params });
      const p = params ?? [];
      if (/INSERT INTO sdk_program_state/.test(text)) {
        const k = key(p);
        if (store.has(k)) {
          return { rows: [] } as SdkQueryResult<T>; // lost the claim (row already present)
        }
        store.set(k, p[3] as string);
        return { rows: [{ watermark: p[3] }] } as unknown as SdkQueryResult<T>;
      }
      if (/SELECT watermark FROM sdk_program_state/.test(text)) {
        const k = key(p);
        const watermark = store.get(k);
        return {
          rows: watermark === undefined ? [] : [{ watermark }],
        } as unknown as SdkQueryResult<T>;
      }
      return { rows: [] } as SdkQueryResult<T>;
    }
  );

  const pool: SdkPool = { query: query as unknown as SdkPool["query"] };
  return { pool, calls, store, query };
}

/** Build a full, valid config over a given pool. */
function fullConfig(pool: SdkPool, over: Partial<EnvoyConfig> = {}): EnvoyConfig {
  return {
    db: pool,
    installNamespace: "prod",
    resendApiKey: "re_test_123",
    webhookSecret: "whsec_test",
    cronSecret: "cron_test",
    unsubscribeSecret: "unsub_test",
    baseSegmentId: "seg_base",
    ...over,
  };
}

// ---------------------------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------------------------

describe("createEnvoy — happy path", () => {
  it("returns a handle exposing config, db, resend, and server-fn foundations", () => {
    const { pool } = fakeFingerprintPool();
    const envoy = createEnvoy(fullConfig(pool));

    expect(envoy.config.installNamespace).toBe("prod");
    expect(envoy.config.baseSegmentId).toBe("seg_base");
    expect(envoy.db.namespace).toBe("prod");
    expect(envoy.resend.enabled).toBe(true);
    expect(typeof envoy.assertNamespaceFingerprint).toBe("function");
    expect(typeof envoy.redact).toBe("function");
  });

  it("applies defaults: empty allow-list and empty streams when omitted", () => {
    const { pool } = fakeFingerprintPool();
    const envoy = createEnvoy(fullConfig(pool));
    expect(envoy.config.aiFieldAllowList).toEqual([]);
    expect(envoy.config.streams).toEqual({});
  });

  it("normalizes the AI field allow-list (dedupes, freezes) — R44", () => {
    const { pool } = fakeFingerprintPool();
    const envoy = createEnvoy(
      fullConfig(pool, { aiFieldAllowList: ["firstName", "company", "firstName"] })
    );
    expect(envoy.config.aiFieldAllowList).toEqual(["firstName", "company"]);
    expect(Object.isFrozen(envoy.config.aiFieldAllowList)).toBe(true);
  });

  it("accepts and freezes an optional agent config — R24", () => {
    const { pool } = fakeFingerprintPool();
    const envoy = createEnvoy(
      fullConfig(pool, { agent: { agentId: "agent_1", environmentId: "env_1" } })
    );
    expect(envoy.config.agent).toEqual({ agentId: "agent_1", environmentId: "env_1" });
  });

  it("accepts stream defaults keyed by stream name", () => {
    const { pool } = fakeFingerprintPool();
    const envoy = createEnvoy(
      fullConfig(pool, { streams: { digest: { from: "news@acme.com" } } })
    );
    expect(envoy.config.streams.digest?.from).toBe("news@acme.com");
  });
});

// ---------------------------------------------------------------------------------------------
// Error: missing required secrets fail at INIT, not send time
// ---------------------------------------------------------------------------------------------

describe("createEnvoy — required-secret validation (fail loud at init)", () => {
  it("throws a clear error when webhookSecret is missing", () => {
    const { pool } = fakeFingerprintPool();
    const cfg = fullConfig(pool) as unknown as Record<string, unknown>;
    delete cfg.webhookSecret;
    expect(() => createEnvoy(cfg as unknown as EnvoyConfig)).toThrow(EnvoyConfigError);
    expect(() => createEnvoy(cfg as unknown as EnvoyConfig)).toThrow(/webhookSecret/);
  });

  it("throws a clear error when cronSecret is missing", () => {
    const { pool } = fakeFingerprintPool();
    const cfg = fullConfig(pool) as unknown as Record<string, unknown>;
    delete cfg.cronSecret;
    expect(() => createEnvoy(cfg as unknown as EnvoyConfig)).toThrow(/cronSecret/);
  });

  it("throws a clear error when unsubscribeSecret is missing", () => {
    const { pool } = fakeFingerprintPool();
    const cfg = fullConfig(pool) as unknown as Record<string, unknown>;
    delete cfg.unsubscribeSecret;
    expect(() => createEnvoy(cfg as unknown as EnvoyConfig)).toThrow(/unsubscribeSecret/);
  });

  it("throws when baseSegmentId is missing", () => {
    const { pool } = fakeFingerprintPool();
    const cfg = fullConfig(pool) as unknown as Record<string, unknown>;
    delete cfg.baseSegmentId;
    expect(() => createEnvoy(cfg as unknown as EnvoyConfig)).toThrow(/baseSegmentId/);
  });

  it("throws when installNamespace is missing", () => {
    const { pool } = fakeFingerprintPool();
    const cfg = fullConfig(pool) as unknown as Record<string, unknown>;
    delete cfg.installNamespace;
    expect(() => createEnvoy(cfg as unknown as EnvoyConfig)).toThrow(/installNamespace/);
  });

  it("rejects an empty-string secret as well as an absent one", () => {
    const { pool } = fakeFingerprintPool();
    expect(() => createEnvoy(fullConfig(pool, { cronSecret: "   " }))).toThrow(/cronSecret/);
  });

  it("throws when db is not a pg-compatible pool", () => {
    expect(() =>
      createEnvoy({ ...fullConfig({} as SdkPool) } as EnvoyConfig)
    ).toThrow(/pg-compatible pool/);
  });

  it("throws when a partial agent block omits environmentId", () => {
    const { pool } = fakeFingerprintPool();
    expect(() =>
      createEnvoy(
        fullConfig(pool, {
          agent: { agentId: "a" } as unknown as EnvoyConfig["agent"],
        })
      )
    ).toThrow(/agent\.environmentId/);
  });

  it("does NOT throw when resendApiKey is missing (optional, no-op lane)", () => {
    const { pool } = fakeFingerprintPool();
    const cfg = fullConfig(pool) as unknown as Record<string, unknown>;
    delete cfg.resendApiKey;
    expect(() => createEnvoy(cfg as unknown as EnvoyConfig)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------------------------
// Edge: Resend no-op when key unset
// ---------------------------------------------------------------------------------------------

describe("Resend client — lazy + no-op when key unset (R43)", () => {
  it("constructs no Resend client and reports disabled when key is unset", () => {
    const handle = createResendClientHandle(undefined);
    expect(handle.enabled).toBe(false);
    expect(handle.client()).toBeNull();
  });

  it("treats an empty/whitespace key as unset (no throw)", () => {
    expect(createResendClientHandle("").enabled).toBe(false);
    expect(createResendClientHandle("   ").enabled).toBe(false);
    expect(createResendClientHandle("   ").client()).toBeNull();
  });

  it("constructs a Resend client lazily and memoizes it when a key is present", () => {
    const handle = createResendClientHandle("re_test_123");
    expect(handle.enabled).toBe(true);
    const first = handle.client();
    const second = handle.client();
    expect(first).not.toBeNull();
    expect(second).toBe(first); // same instance (lazy singleton)
  });

  it("createEnvoy with no resendApiKey yields a disabled, non-throwing Resend handle", () => {
    const { pool } = fakeFingerprintPool();
    const cfg = fullConfig(pool) as unknown as Record<string, unknown>;
    delete cfg.resendApiKey;
    const envoy = createEnvoy(cfg as unknown as EnvoyConfig);
    expect(envoy.resend.enabled).toBe(false);
    expect(envoy.resend.client()).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// Namespace fingerprint (R38)
// ---------------------------------------------------------------------------------------------

describe("namespace fingerprint (R38)", () => {
  it("first install writes the sentinel and resolves", async () => {
    const { pool, store } = fakeFingerprintPool();
    const envoy = createEnvoy(fullConfig(pool));
    await expect(envoy.assertNamespaceFingerprint()).resolves.toBeUndefined();
    expect(store.size).toBe(1);
  });

  it("is idempotent: a second identical install matches the stored fingerprint", async () => {
    const { pool } = fakeFingerprintPool();
    const a = createEnvoy(fullConfig(pool));
    await a.assertNamespaceFingerprint();
    // A separate handle (e.g. a new request) over the same DB + same config must not throw.
    const b = createEnvoy(fullConfig(pool));
    await expect(b.assertNamespaceFingerprint()).resolves.toBeUndefined();
  });

  it("memoizes within one handle — a second call does not re-hit the DB", async () => {
    const { pool, query } = fakeFingerprintPool();
    const envoy = createEnvoy(fullConfig(pool));
    await envoy.assertNamespaceFingerprint();
    const callsAfterFirst = query.mock.calls.length;
    await envoy.assertNamespaceFingerprint();
    expect(query.mock.calls.length).toBe(callsAfterFirst);
  });

  it("fails loud when the same namespace is reused with a different config identity", async () => {
    const { pool } = fakeFingerprintPool();
    // First install fingerprints namespace "prod" with baseSegmentId seg_base.
    await createEnvoy(fullConfig(pool)).assertNamespaceFingerprint();
    // A second install claims the SAME namespace but a different base Segment — a cross-install
    // collision that must fail loud rather than silently merge consent/claims/PII.
    const intruder = createEnvoy(fullConfig(pool, { baseSegmentId: "seg_OTHER" }));
    await expect(intruder.assertNamespaceFingerprint()).rejects.toBeInstanceOf(
      EnvoyNamespaceError
    );
    await expect(
      createEnvoy(fullConfig(pool, { baseSegmentId: "seg_OTHER" })).assertNamespaceFingerprint()
    ).rejects.toThrow(/different @catalystiq\/envoy-sdk install/);
  });

  it("two distinct namespaces on one DB coexist (staging/prod split is two installs)", async () => {
    const { pool } = fakeFingerprintPool();
    await createEnvoy(fullConfig(pool, { installNamespace: "prod" })).assertNamespaceFingerprint();
    await expect(
      createEnvoy(fullConfig(pool, { installNamespace: "staging" })).assertNamespaceFingerprint()
    ).resolves.toBeUndefined();
  });

  it("a transient DB error is not cached — the next call retries", async () => {
    const { store } = fakeFingerprintPool();
    let fail = true;
    const flakyPool: SdkPool = {
      query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
        if (fail && /INSERT INTO sdk_program_state/.test(text)) {
          throw new Error("connection reset");
        }
        if (/INSERT INTO sdk_program_state/.test(text)) {
          const k = `${params?.[0]}|${params?.[1]}|${params?.[2]}`;
          store.set(k, params?.[3] as string);
          return { rows: [{ watermark: params?.[3] }] } as never;
        }
        return { rows: [] } as never;
      }) as unknown as SdkPool["query"],
    };
    const envoy = createEnvoy(fullConfig(flakyPool));
    await expect(envoy.assertNamespaceFingerprint()).rejects.toThrow(/connection reset/);
    fail = false;
    await expect(envoy.assertNamespaceFingerprint()).resolves.toBeUndefined();
  });

  it("a blank stored sentinel fails loud (inconsistent partial install)", async () => {
    // Pool whose claim loses (row exists) but whose SELECT returns a blank watermark.
    const pool: SdkPool = {
      query: vi.fn(async (text: string) => {
        if (/INSERT INTO sdk_program_state/.test(text)) return { rows: [] } as never; // lost claim
        if (/SELECT watermark/.test(text)) return { rows: [{ watermark: "" }] } as never;
        return { rows: [] } as never;
      }) as unknown as SdkPool["query"],
    };
    const envoy = createEnvoy(fullConfig(pool));
    await expect(envoy.assertNamespaceFingerprint()).rejects.toThrow(/no value/);
  });

  it("computeNamespaceFingerprint is deterministic and excludes secrets", () => {
    const { pool } = fakeFingerprintPool();
    const a = resolveConfig(fullConfig(pool));
    const b = resolveConfig(fullConfig(pool, { resendApiKey: "re_DIFFERENT" }));
    // Same namespace + base segment, different secret -> SAME fingerprint (rotating a key must not
    // trip the guard).
    expect(computeNamespaceFingerprint(a)).toBe(computeNamespaceFingerprint(b));
    // Different base segment -> different fingerprint.
    const c = resolveConfig(fullConfig(pool, { baseSegmentId: "seg_x" }));
    expect(computeNamespaceFingerprint(a)).not.toBe(computeNamespaceFingerprint(c));
  });
});

// ---------------------------------------------------------------------------------------------
// Redaction + no-secret-leak (R43)
// ---------------------------------------------------------------------------------------------

describe("secret + PII redaction (R43)", () => {
  it("redacts an email to a non-reversible hint", () => {
    expect(redactEmail("marko@example.com")).toBe("m***@example.com");
  });

  it("fully masks a malformed email", () => {
    expect(redactEmail("not-an-email")).toBe("***");
    expect(redactEmail("@example.com")).toBe("***");
    expect(redactEmail("local@")).toBe("***");
  });

  it("redactValue masks non-string and secret-like values entirely", () => {
    expect(redactValue("whsec_supersecret")).toBe("***");
    expect(redactValue(12345)).toBe("***");
    expect(redactValue(undefined)).toBe("***");
    expect(redactValue({ token: "x" })).toBe("***");
  });

  it("redactValue hints an email but never returns the full local-part", () => {
    const out = redactValue("alice@corp.io");
    expect(out).toBe("a***@corp.io");
    expect(out).not.toContain("alice");
  });

  it("the handle's redact() delegates to redactValue", () => {
    const { pool } = fakeFingerprintPool();
    const envoy = createEnvoy(fullConfig(pool));
    expect(envoy.redact("bob@b.com")).toBe("b***@b.com");
    expect(envoy.redact(envoy.config.cronSecret)).toBe("***");
  });

  it("JSON-serializing the handle never emits any secret or full email", () => {
    const { pool } = fakeFingerprintPool();
    const envoy = createEnvoy(
      fullConfig(pool, {
        resendApiKey: "re_SECRET_KEY",
        webhookSecret: "whsec_SECRET",
        cronSecret: "cron_SECRET",
        unsubscribeSecret: "unsub_SECRET",
      })
    );
    const serialized = JSON.stringify(envoy);
    for (const secret of [
      "re_SECRET_KEY",
      "whsec_SECRET",
      "cron_SECRET",
      "unsub_SECRET",
    ]) {
      expect(serialized).not.toContain(secret);
    }
    // It still exposes safe, non-secret metadata.
    expect(serialized).toContain("installNamespace");
    expect(serialized).toContain("resendEnabled");
  });

  it("config errors carry no secret values in their message", () => {
    const { pool } = fakeFingerprintPool();
    const cfg = fullConfig(pool, { cronSecret: "" });
    try {
      createEnvoy(cfg);
      throw new Error("expected throw");
    } catch (err) {
      expect((err as Error).message).not.toContain("re_test_123");
      expect((err as Error).message).not.toContain("whsec_test");
    }
  });
});
