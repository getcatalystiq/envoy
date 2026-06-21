import { describe, expect, it, vi } from "vitest";

import {
  ConsentMirror,
  createConsentMirror,
  CONSENT_RANK,
  STREAMS,
  type ConsentStatus,
} from "@sdk/consent/mirror.js";
import { createDb, type SdkPool } from "@sdk/db/pool.js";
import { createResendClientHandle } from "@sdk/resend/client.js";

// ---------------------------------------------------------------------------------------------
// In-memory fake of the bits of Postgres `mirror.ts` exercises. Rather than re-run the SQL CASE
// logic, this models the SAME monotonic-merge semantics in JS so the tests assert the behavior the
// real upsert produces. Keyed by (namespace, contact, topic_key).
// ---------------------------------------------------------------------------------------------

interface StoreRow {
  contact: string;
  topic_key: string;
  topic_id: string | null;
  digest_status: ConsentStatus;
  alert_status: ConsentStatus;
  dirty_since: string | null;
}

function rank(s: ConsentStatus | null): number {
  if (s === null) return -1;
  return CONSENT_RANK[s];
}

/**
 * Build a fake pool whose `query` interprets the handful of statements `mirror.ts` issues:
 *   - the consent INSERT … ON CONFLICT … RETURNING (monotonic merge upsert)
 *   - the SELECT of a consent row
 *   - the dirty-clear UPDATE on sdk_topic_consent
 *   - the global-suppress UPDATE on sdk_contacts
 */
function fakeConsentPool() {
  const consent = new Map<string, StoreRow>();
  const contacts = new Map<string, { unsubscribed: boolean }>();
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];

  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();

      // --- consent upsert (monotonic merge) ---
      if (t.startsWith("INSERT INTO sdk_topic_consent")) {
        const [, contact, topicKey, topicId, wantDigest, wantAlert] = params as [
          string,
          string,
          string,
          string | null,
          ConsentStatus | null,
          ConsentStatus | null
        ];
        const key = `${contact}::${topicKey}`;
        const existing = consent.get(key);
        if (!existing) {
          const row: StoreRow = {
            contact,
            topic_key: topicKey,
            topic_id: topicId,
            digest_status: wantDigest ?? "opt_in",
            alert_status: wantAlert ?? "opt_in",
            dirty_since: "now",
          };
          consent.set(key, row);
          return { rows: [{ ...row }] } as never;
        }
        // merge: take the more-suppressed value per stream; null = keep
        const mergedDigest =
          wantDigest !== null && rank(wantDigest) >= rank(existing.digest_status)
            ? wantDigest
            : existing.digest_status;
        const mergedAlert =
          wantAlert !== null && rank(wantAlert) >= rank(existing.alert_status)
            ? wantAlert
            : existing.alert_status;
        existing.topic_id = topicId ?? existing.topic_id;
        existing.digest_status = mergedDigest;
        existing.alert_status = mergedAlert;
        existing.dirty_since = "now";
        return { rows: [{ ...existing }] } as never;
      }

      // --- consent SELECT ---
      if (t.startsWith("SELECT contact, topic_key")) {
        const [, contact, topicKey] = params as [string, string, string];
        const row = consent.get(`${contact}::${topicKey}`);
        return { rows: row ? [{ ...row }] : [] } as never;
      }

      // --- dirty-clear UPDATE ---
      if (t.startsWith("UPDATE sdk_topic_consent SET dirty_since = NULL")) {
        const [, contact, topicKey] = params as [string, string, string];
        const row = consent.get(`${contact}::${topicKey}`);
        if (row) row.dirty_since = null;
        return { rows: [] } as never;
      }

      // --- global suppress UPDATE ---
      if (t.startsWith("UPDATE sdk_contacts SET unsubscribed = TRUE")) {
        const [, email] = params as [string, string];
        contacts.set(email, { unsubscribed: true });
        return { rows: [] } as never;
      }

      return { rows: [] } as never;
    }),
  };

  return { pool, consent, contacts, calls };
}

/** A Resend handle whose `contacts.topics.update` is a controllable spy. */
function fakeResend(opts?: {
  enabled?: boolean;
  error?: unknown;
  throws?: boolean;
}) {
  const update = vi.fn(async () => {
    if (opts?.throws) throw new Error("network");
    return { data: opts?.error ? null : { id: "ct_1" }, error: opts?.error ?? null };
  });
  const handle = createResendClientHandle(
    opts?.enabled === false ? undefined : "re_test_key"
  );
  if (opts?.enabled !== false) {
    // Replace the lazily-built client with a stub exposing only what mirror.set touches.
    vi.spyOn(handle, "client").mockReturnValue({
      contacts: { topics: { update } },
    } as never);
  }
  return { handle, update };
}

function setup(resendOpts?: Parameters<typeof fakeResend>[0]) {
  const { pool, consent, contacts } = fakeConsentPool();
  const db = createDb(pool, "prod");
  const { handle, update } = fakeResend(resendOpts);
  const mirror = createConsentMirror(db, handle);
  return { mirror, consent, contacts, update, db, handle };
}

describe("createConsentMirror", () => {
  it("returns a ConsentMirror", () => {
    const { mirror } = setup();
    expect(mirror).toBeInstanceOf(ConsentMirror);
  });

  it("exposes both streams", () => {
    expect([...STREAMS].sort()).toEqual(["alert", "digest"]);
  });
});

describe("gate — the send gate (R26)", () => {
  it("denies by default when no row exists (never provisioned)", async () => {
    const { mirror } = setup();
    expect(await mirror.gate("a@example.com", "weekly", "digest")).toBe(false);
  });

  it("allows an opt_in stream", async () => {
    const { mirror } = setup();
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_in",
      topicId: "tp_1",
    });
    expect(await mirror.gate("a@example.com", "weekly", "digest")).toBe(true);
  });

  it("Covers R26: consent.set digest off writes the opt-out and gate then denies", async () => {
    const { mirror, update } = setup();
    const res = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_out",
      topicId: "tp_1",
    });
    expect(res.changed).toBe(true);
    expect(res.push).toBe("confirmed");
    // pushed opt_out to Resend for this stream
    expect(update).toHaveBeenCalledWith({
      email: "a@example.com",
      topics: [{ id: "tp_1", subscription: "opt_out" }],
    });
    expect(await mirror.gate("a@example.com", "weekly", "digest")).toBe(false);
  });

  it("a global unsubscribe denies BOTH streams (suppress-all dominates)", async () => {
    const { mirror, contacts } = setup();
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "unsubscribed",
      topicId: "tp_1",
    });
    expect(await mirror.gate("a@example.com", "weekly", "digest")).toBe(false);
    expect(await mirror.gate("a@example.com", "weekly", "alert")).toBe(false);
    // and the contact-level global flag is set
    expect(contacts.get("a@example.com")?.unsubscribed).toBe(true);
  });

  it("a digest opt-out leaves the alert stream flowing (dual-stream independence)", async () => {
    const { mirror } = setup();
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_in",
      topicId: "tp_1",
    });
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "alert",
      status: "opt_in",
      topicId: "tp_1",
    });
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_out",
      topicId: "tp_1",
    });
    expect(await mirror.gate("a@example.com", "weekly", "digest")).toBe(false);
    expect(await mirror.gate("a@example.com", "weekly", "alert")).toBe(true);
  });
});

describe("set — monotonic merge (unsubscribed dominates)", () => {
  it("Edge: a stale opt_in never overrides a stored unsubscribed (same stream)", async () => {
    const { mirror } = setup();
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "unsubscribed",
      topicId: "tp_1",
    });
    const res = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_in",
      topicId: "tp_1",
    });
    expect(res.changed).toBe(false); // the merge rejected the regress
    expect(res.row.digest).toBe("unsubscribed");
    expect(await mirror.gate("a@example.com", "weekly", "digest")).toBe(false);
  });

  it("Edge: a stale opt_in on the alert stream never overrides an unsubscribed set via digest", async () => {
    const { mirror } = setup();
    // Global unsub came in via the digest stream → both streams unsubscribed.
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "unsubscribed",
      topicId: "tp_1",
    });
    const res = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "alert",
      status: "opt_in",
      topicId: "tp_1",
    });
    expect(res.changed).toBe(false);
    expect(res.row.alert).toBe("unsubscribed");
  });

  it("opt_out does not regress to opt_in (monotonic), but does upgrade to unsubscribed", async () => {
    const { mirror } = setup();
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_out",
      topicId: "tp_1",
    });
    const back = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_in",
      topicId: "tp_1",
    });
    expect(back.changed).toBe(false);
    expect(back.row.digest).toBe("opt_out");

    const up = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "unsubscribed",
      topicId: "tp_1",
    });
    expect(up.changed).toBe(true);
    expect(up.row.digest).toBe("unsubscribed");
  });
});

describe("set — Resend push (awaited, fail-soft)", () => {
  it("confirms and clears dirty on a successful push", async () => {
    const { mirror, consent, update } = setup();
    const res = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_out",
      topicId: "tp_1",
    });
    expect(update).toHaveBeenCalledTimes(1);
    expect(res.push).toBe("confirmed");
    expect(res.row.dirty).toBe(false);
    expect(consent.get("prod:a@example.com::weekly")?.dirty_since).toBeNull();
  });

  it("marks the row reconcile-dirty when the push returns an error (no throw)", async () => {
    const { mirror, consent } = setup({ error: { message: "boom", name: "x" } });
    const res = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_out",
      topicId: "tp_1",
    });
    expect(res.push).toBe("dirty");
    expect(res.row.dirty).toBe(true);
    expect(consent.get("prod:a@example.com::weekly")?.dirty_since).not.toBeNull();
  });

  it("marks the row reconcile-dirty when the push THROWS (transport error)", async () => {
    const { mirror } = setup({ throws: true });
    const res = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_out",
      topicId: "tp_1",
    });
    expect(res.push).toBe("dirty");
    expect(res.row.dirty).toBe(true);
  });

  it("Edge: unset RESEND_API_KEY makes the push a silent no-op (skipped, no throw)", async () => {
    const { mirror, update } = setup({ enabled: false });
    const res = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_out",
      topicId: "tp_1",
    });
    expect(res.push).toBe("skipped");
    expect(update).not.toHaveBeenCalled();
  });

  it("skips the push when no topic id is cached (nothing addressable)", async () => {
    const { mirror, update } = setup();
    const res = await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_out",
      // no topicId
    });
    expect(res.push).toBe("skipped");
    expect(update).not.toHaveBeenCalled();
    // and the row stays dirty for reconcile to resolve
    expect(res.row.dirty).toBe(true);
  });
});

describe("read", () => {
  it("returns null for an unknown contact/topic", async () => {
    const { mirror } = setup();
    expect(await mirror.read("nobody@example.com", "weekly")).toBeNull();
  });

  it("namespace-prefixes the contact key at the DB boundary (KTD7)", async () => {
    const { mirror, consent } = setup();
    await mirror.set({
      email: "a@example.com",
      topicKey: "weekly",
      stream: "digest",
      status: "opt_in",
      topicId: "tp_1",
    });
    // stored under the namespaced contact key
    expect(consent.has("prod:a@example.com::weekly")).toBe(true);
  });
});
