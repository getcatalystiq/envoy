import { describe, expect, it, vi } from "vitest";

import { reconcile, reconcileContact } from "@sdk/broadcast/reconcile.js";
import { createDb, type SdkPool } from "@sdk/db/pool.js";
import { createResendClientHandle } from "@sdk/resend/client.js";
import type { ResendClientHandle } from "@sdk/resend/client.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";

// =============================================================================================
// In-memory fake of the Postgres slice U14 (reconcile.ts) touches:
//   - sdk_program_state SELECT under program_key = "__envoy_topics__"        (topic-id cache)
//   - sdk_program_state SELECT/UPSERT under "__envoy_reconcile_sweep__"      (full-sweep cursor)
//   - sdk_topic_consent UPSERT (monotonic opt_out write)                      (mirror repair)
//   - sdk_contacts SELECT (dirty page / full page) + dirty clear/restamp      (the sweep + flag)
// Returns `rows` with NO `rowCount` (like Neon's HTTP driver) so a module reading rowCount fails.
// =============================================================================================

const NAMESPACE = "prod";
const NS = (email: string) => `${NAMESPACE}:${email}`; // mirrors NamespacedDb.namespaceKey

interface ContactRow {
  id: number;
  email: string;
  unsubscribed: boolean;
  dirty: boolean;
}
interface ConsentRow {
  contact: string; // namespaced
  topic_key: string;
  topic_id: string | null;
  digest_status: "opt_in" | "opt_out" | "unsubscribed";
  alert_status: "opt_in" | "opt_out" | "unsubscribed";
  dirty: boolean;
}

interface FakeDbSeed {
  /** topicKey -> topicId provisioning-cache rows (program_key = "__envoy_topics__"). */
  topicCache?: Record<string, string>;
  contacts?: Array<Partial<ContactRow> & { email: string }>;
  consent?: ConsentRow[];
  /** Pre-seed the full-sweep resume cursor (watermark under __envoy_reconcile_sweep__). */
  sweepCursor?: string | null;
}

function fakeDb(seed: FakeDbSeed = {}) {
  const topicCache = new Map<string, string>(); // topicKey -> topicId
  const sweep = { cursor: seed.sweepCursor ?? (null as string | null), present: seed.sweepCursor !== undefined };
  const contacts = new Map<string, ContactRow>(); // email -> row
  const consent = new Map<string, ConsentRow>(); // `${contact}|${topic_key}` -> row
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];

  let nextId = 1;
  for (const c of seed.contacts ?? []) {
    const id = c.id ?? nextId++;
    contacts.set(c.email, {
      id,
      email: c.email,
      unsubscribed: c.unsubscribed ?? false,
      dirty: c.dirty ?? false,
    });
  }
  for (const [k, v] of Object.entries(seed.topicCache ?? {})) topicCache.set(k, v);
  for (const r of seed.consent ?? []) consent.set(`${r.contact}|${r.topic_key}`, { ...r });

  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();
      const p = params ?? [];

      // --- topic-id cache read (reverse map source) ---
      if (
        t.startsWith("SELECT subject_key, watermark FROM sdk_program_state") &&
        p[1] === "__envoy_topics__"
      ) {
        const rows = [...topicCache.entries()].map(([subject_key, watermark]) => ({
          subject_key,
          watermark,
        }));
        return { rows } as never;
      }

      // --- full-sweep cursor read ---
      if (
        t.startsWith("SELECT watermark FROM sdk_program_state") &&
        p[1] === "__envoy_reconcile_sweep__"
      ) {
        return { rows: sweep.present ? [{ watermark: sweep.cursor }] : [] } as never;
      }

      // --- full-sweep cursor upsert ---
      if (
        t.startsWith("INSERT INTO sdk_program_state") &&
        p[1] === "__envoy_reconcile_sweep__"
      ) {
        sweep.cursor = (p[3] as string | null) ?? null;
        sweep.present = true;
        return { rows: [{ namespace: p[0] }] } as never;
      }

      // --- mirror opt_out upsert ---
      if (t.startsWith("INSERT INTO sdk_topic_consent")) {
        const [, contact, topicKey, topicId, wantDigest, wantAlert] = p as [
          string,
          string,
          string,
          string | null,
          ConsentRow["digest_status"] | null,
          ConsentRow["alert_status"] | null,
        ];
        const key = `${contact}|${topicKey}`;
        const rank = (s: string | null) =>
          s === "unsubscribed" ? 2 : s === "opt_out" ? 1 : s === "opt_in" ? 0 : -1;
        const existing = consent.get(key);
        if (!existing) {
          consent.set(key, {
            contact,
            topic_key: topicKey,
            topic_id: topicId,
            digest_status: wantDigest ?? "opt_in",
            alert_status: wantAlert ?? "opt_in",
            dirty: false,
          });
        } else {
          if (topicId !== null) existing.topic_id = topicId;
          if (wantDigest !== null && rank(wantDigest) >= rank(existing.digest_status)) {
            existing.digest_status = wantDigest;
          }
          if (wantAlert !== null && rank(wantAlert) >= rank(existing.alert_status)) {
            existing.alert_status = wantAlert;
          }
          existing.dirty = false;
        }
        return { rows: [{ contact }] } as never;
      }

      // --- dirty contacts page ---
      if (
        t.startsWith("SELECT id, email FROM sdk_contacts") &&
        t.includes("dirty_since IS NOT NULL")
      ) {
        const limit = p[1] as number;
        const rows = [...contacts.values()]
          .filter((c) => c.dirty)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((c) => ({ id: c.id, email: c.email }));
        return { rows } as never;
      }

      // --- full page from start ---
      if (
        t.startsWith("SELECT id, email FROM sdk_contacts") &&
        t.includes("ORDER BY id ASC") &&
        !t.includes("id > $2") &&
        !t.includes("dirty_since")
      ) {
        const limit = p[1] as number;
        const rows = [...contacts.values()]
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((c) => ({ id: c.id, email: c.email }));
        return { rows } as never;
      }

      // --- full page after cursor ---
      if (
        t.startsWith("SELECT id, email FROM sdk_contacts") &&
        t.includes("id > $2")
      ) {
        const cursor = Number(p[1]);
        const limit = p[2] as number;
        const rows = [...contacts.values()]
          .filter((c) => c.id > cursor)
          .sort((a, b) => a.id - b.id)
          .slice(0, limit)
          .map((c) => ({ id: c.id, email: c.email }));
        return { rows } as never;
      }

      // --- contact dirty clear ---
      if (t.startsWith("UPDATE sdk_contacts SET dirty_since = NULL")) {
        const row = contacts.get(p[1] as string);
        if (row) row.dirty = false;
        return { rows: row ? [{}] : [] } as never;
      }

      // --- contact dirty re-stamp ---
      if (t.startsWith("UPDATE sdk_contacts SET dirty_since = NOW()")) {
        const row = contacts.get(p[1] as string);
        if (row) row.dirty = true;
        return { rows: row ? [{}] : [] } as never;
      }

      return { rows: [] } as never;
    }),
  };

  return { pool, contacts, consent, calls, sweep };
}

// ---------------------------------------------------------------------------------------------
// Resend fake: contacts.topics.list (paginated) + contacts.segments.add, controllable.
// ---------------------------------------------------------------------------------------------

interface ResendSeed {
  enabled?: boolean;
  /** Topics returned by contacts.topics.list, per email. */
  topicsByEmail?: Record<string, Array<{ id: string; subscription: "opt_in" | "opt_out" }>>;
  /** When set, topics.list rejects (throws) — used to simulate a 429 or other transport error. */
  listThrows?: { statusCode?: number; name?: string; message?: string };
  /** When set, topics.list returns an in-band Resend error. */
  listError?: { statusCode?: number; name?: string; message?: string };
  /** When set, segments.add returns an in-band error with this reason. */
  segmentAddError?: { message: string };
  /** Optional multi-page response per email: each call returns the next page. */
  pagesByEmail?: Record<
    string,
    Array<{ data: Array<{ id: string; subscription: "opt_in" | "opt_out" }>; has_more: boolean }>
  >;
}

function fakeResend(seed: ResendSeed = {}) {
  const topicsList = vi.fn(
    async ({ email, after }: { email: string; after?: string }) => {
      if (seed.listThrows) throw seed.listThrows;
      if (seed.listError) return { data: null, error: seed.listError };
      if (seed.pagesByEmail?.[email]) {
        const pages = seed.pagesByEmail[email]!;
        // Page index = number of entries already cursored past. We model it via `after`: first call
        // has no `after`, subsequent calls supply the last id; map id -> page index by lookup.
        const idx = after === undefined ? 0 : findPageIndex(pages, after);
        const page = pages[idx] ?? { data: [], has_more: false };
        return { data: { object: "list", data: page.data, has_more: page.has_more }, error: null };
      }
      const data = seed.topicsByEmail?.[email] ?? [];
      return { data: { object: "list", data, has_more: false }, error: null };
    }
  );

  const segmentAdd = vi.fn(async () => ({
    data: seed.segmentAddError ? null : { id: "seg_add" },
    error: seed.segmentAddError ?? null,
  }));

  const handle = createResendClientHandle(seed.enabled === false ? undefined : "re_test_key");
  if (seed.enabled !== false) {
    vi.spyOn(handle, "client").mockReturnValue({
      contacts: {
        topics: { list: topicsList },
        segments: { add: segmentAdd },
      },
    } as never);
  }
  return { handle, spies: { topicsList, segmentAdd } };
}

function findPageIndex(
  pages: Array<{ data: Array<{ id: string }>; has_more: boolean }>,
  lastId: string
): number {
  for (let i = 0; i < pages.length; i += 1) {
    const last = pages[i]!.data[pages[i]!.data.length - 1];
    if (last?.id === lastId) return i + 1;
  }
  return pages.length; // past the end → empty page
}

function makeEnvoy(
  pool: SdkPool,
  resend: ResendClientHandle,
  overrides?: Partial<ResolvedEnvoyConfig>
): Envoy {
  const db = createDb(pool, NAMESPACE);
  const config = {
    installNamespace: NAMESPACE,
    resendApiKey: resend.enabled ? "re_test_key" : undefined,
    webhookSecret: "whsec",
    cronSecret: "cron-secret",
    unsubscribeSecret: "unsub-secret",
    baseSegmentId: "seg_base",
    agent: undefined,
    aiFieldAllowList: Object.freeze([]),
    streams: Object.freeze({}),
    ...overrides,
  } as ResolvedEnvoyConfig;
  return {
    config,
    db,
    resend,
    assertNamespaceFingerprint: async () => {},
    redact: (v: unknown) => (String(v).includes("@") ? "a***@redacted" : "***"),
  };
}

const noSleep = async () => {};

// =============================================================================================
// reconcileContact — the per-contact topics diff + segment repair
// =============================================================================================

describe("reconcileContact (R29 topics diff)", () => {
  it("Happy: a topic flipped to opt_out in Resend is written to the mirror", async () => {
    const db = fakeDb({
      topicCache: { "digest:weekly": "tp_1" },
      contacts: [{ email: "a@x.com", dirty: true }],
      consent: [
        {
          contact: NS("a@x.com"),
          topic_key: "digest:weekly",
          topic_id: "tp_1",
          digest_status: "opt_in",
          alert_status: "opt_in",
          dirty: false,
        },
      ],
    });
    const { handle } = fakeResend({
      topicsByEmail: { "a@x.com": [{ id: "tp_1", subscription: "opt_out" }] },
    });
    const envoy = makeEnvoy(db.pool, handle);

    const topicCache = new Map([
      ["tp_1", { topicId: "tp_1", topicKey: "digest:weekly", stream: "digest" as const, subject: "weekly" }],
    ]);
    const r = await reconcileContact(envoy, { email: "a@x.com", topicCache, sleepFn: noSleep });

    expect(r.outcome).toBe("reconciled");
    expect(r.optedOut).toEqual(["digest:weekly"]);
    // Mirror now reflects the opt_out on the digest stream.
    expect(db.consent.get(`${NS("a@x.com")}|digest:weekly`)?.digest_status).toBe("opt_out");
    // The contact's dirty flag was cleared (clean pass).
    expect(db.contacts.get("a@x.com")?.dirty).toBe(false);
  });

  it("monotonic: a reconcile opt_out never regresses a stored unsubscribed", async () => {
    const db = fakeDb({
      topicCache: { "alert:law": "tp_9" },
      contacts: [{ email: "u@x.com", dirty: true }],
      consent: [
        {
          contact: NS("u@x.com"),
          topic_key: "alert:law",
          topic_id: "tp_9",
          digest_status: "unsubscribed",
          alert_status: "unsubscribed",
          dirty: false,
        },
      ],
    });
    const { handle } = fakeResend({
      topicsByEmail: { "u@x.com": [{ id: "tp_9", subscription: "opt_out" }] },
    });
    const envoy = makeEnvoy(db.pool, handle);
    const topicCache = new Map([
      ["tp_9", { topicId: "tp_9", topicKey: "alert:law", stream: "alert" as const, subject: "law" }],
    ]);

    const r = await reconcileContact(envoy, { email: "u@x.com", topicCache, sleepFn: noSleep });
    expect(r.outcome).toBe("reconciled");
    // unsubscribed (rank 2) dominates the incoming opt_out (rank 1) — stays unsubscribed.
    expect(db.consent.get(`${NS("u@x.com")}|alert:law`)?.alert_status).toBe("unsubscribed");
  });

  it("Edge: an opted-in contact missing from the base Segment is repaired (added)", async () => {
    const db = fakeDb({
      topicCache: { "digest:weekly": "tp_1" },
      contacts: [{ email: "b@x.com", dirty: true }],
    });
    const { handle, spies } = fakeResend({
      topicsByEmail: { "b@x.com": [{ id: "tp_1", subscription: "opt_in" }] },
    });
    const envoy = makeEnvoy(db.pool, handle);
    const topicCache = new Map([
      ["tp_1", { topicId: "tp_1", topicKey: "digest:weekly", stream: "digest" as const, subject: "weekly" }],
    ]);

    const r = await reconcileContact(envoy, { email: "b@x.com", topicCache, sleepFn: noSleep });
    expect(r.outcome).toBe("reconciled");
    expect(r.segmentRepaired).toBe(true);
    // The base Segment add was attempted (intersection-targeting repair).
    expect(spies.segmentAdd).toHaveBeenCalledWith({ email: "b@x.com", segmentId: "seg_base" });
    // opt_in topic → no opt_out flip.
    expect(r.optedOut).toEqual([]);
  });

  it("Error: an unmapped topic id fails loud (marked dirty + surfaced, never ignored)", async () => {
    const db = fakeDb({
      topicCache: { "digest:weekly": "tp_1" }, // tp_unknown is NOT in the cache
      contacts: [{ email: "c@x.com", dirty: true }],
    });
    const { handle } = fakeResend({
      topicsByEmail: {
        "c@x.com": [
          { id: "tp_1", subscription: "opt_in" },
          { id: "tp_unknown", subscription: "opt_out" }, // a consent leak if ignored
        ],
      },
    });
    const envoy = makeEnvoy(db.pool, handle);
    const topicCache = new Map([
      ["tp_1", { topicId: "tp_1", topicKey: "digest:weekly", stream: "digest" as const, subject: "weekly" }],
    ]);

    const r = await reconcileContact(envoy, { email: "c@x.com", topicCache, sleepFn: noSleep });
    expect(r.outcome).toBe("unmapped");
    expect(r.unmappedTopicIds).toEqual(["tp_unknown"]);
    // The contact stays dirty (surfaced for repair) — NOT cleared.
    expect(db.contacts.get("c@x.com")?.dirty).toBe(true);
  });

  it("Error: a 429 from topics.list backs off and resumes (does not abort), contact stays dirty", async () => {
    const db = fakeDb({
      topicCache: { "digest:weekly": "tp_1" },
      contacts: [{ email: "d@x.com", dirty: true }],
    });
    const { handle } = fakeResend({ listThrows: { statusCode: 429, name: "rate_limit_exceeded" } });
    const envoy = makeEnvoy(db.pool, handle);
    const sleepFn = vi.fn(noSleep);
    const topicCache = new Map([
      ["tp_1", { topicId: "tp_1", topicKey: "digest:weekly", stream: "digest" as const, subject: "weekly" }],
    ]);

    const r = await reconcileContact(envoy, {
      email: "d@x.com",
      topicCache,
      backoffMs: 5,
      sleepFn,
    });
    expect(r.outcome).toBe("rate_limited");
    expect(sleepFn).toHaveBeenCalledWith(5);
    // Dirty preserved — the next tick retries this contact.
    expect(db.contacts.get("d@x.com")?.dirty).toBe(true);
  });

  it("Error: a non-429 transport error returns 'error' and leaves the contact dirty", async () => {
    const db = fakeDb({
      topicCache: {},
      contacts: [{ email: "e@x.com", dirty: true }],
    });
    const { handle } = fakeResend({ listThrows: { statusCode: 500, name: "internal" } });
    const envoy = makeEnvoy(db.pool, handle);

    const r = await reconcileContact(envoy, {
      email: "e@x.com",
      topicCache: new Map(),
      sleepFn: noSleep,
    });
    expect(r.outcome).toBe("error");
    expect(db.contacts.get("e@x.com")?.dirty).toBe(true);
  });

  it("Edge: an in-band 429 error (not thrown) also triggers backoff-and-resume", async () => {
    const db = fakeDb({
      topicCache: {},
      contacts: [{ email: "f@x.com", dirty: true }],
    });
    const { handle } = fakeResend({ listError: { statusCode: 429, name: "rate_limit", message: "429" } });
    const envoy = makeEnvoy(db.pool, handle);
    const sleepFn = vi.fn(noSleep);

    const r = await reconcileContact(envoy, {
      email: "f@x.com",
      topicCache: new Map(),
      backoffMs: 3,
      sleepFn,
    });
    expect(r.outcome).toBe("rate_limited");
    expect(sleepFn).toHaveBeenCalled();
  });

  it("Edge: Resend unset → skipped, contact left dirty (no-op, no throw)", async () => {
    const db = fakeDb({
      topicCache: {},
      contacts: [{ email: "g@x.com", dirty: true }],
    });
    const { handle } = fakeResend({ enabled: false });
    const envoy = makeEnvoy(db.pool, handle);

    const r = await reconcileContact(envoy, {
      email: "g@x.com",
      topicCache: new Map(),
      sleepFn: noSleep,
    });
    expect(r.outcome).toBe("skipped");
    expect(db.contacts.get("g@x.com")?.dirty).toBe(true);
  });

  it("paginates contacts.topics.list and diffs every page", async () => {
    const db = fakeDb({
      topicCache: { "digest:a": "tp_a", "digest:b": "tp_b" },
      contacts: [{ email: "h@x.com", dirty: true }],
    });
    const { handle, spies } = fakeResend({
      pagesByEmail: {
        "h@x.com": [
          { data: [{ id: "tp_a", subscription: "opt_out" }], has_more: true },
          { data: [{ id: "tp_b", subscription: "opt_out" }], has_more: false },
        ],
      },
    });
    const envoy = makeEnvoy(db.pool, handle);
    const topicCache = new Map([
      ["tp_a", { topicId: "tp_a", topicKey: "digest:a", stream: "digest" as const, subject: "a" }],
      ["tp_b", { topicId: "tp_b", topicKey: "digest:b", stream: "digest" as const, subject: "b" }],
    ]);

    const r = await reconcileContact(envoy, { email: "h@x.com", topicCache, sleepFn: noSleep });
    expect(r.outcome).toBe("reconciled");
    expect(r.optedOut.sort()).toEqual(["digest:a", "digest:b"]);
    // Two list calls (page 1 + page 2).
    expect(spies.topicsList).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================================
// reconcile (the sweep) — dirty-set narrowing + resumable full-sweep + per-contact fail-soft
// =============================================================================================

describe("reconcile sweep (R29 cost control)", () => {
  it("Edge: dirty-set narrows the per-tick sweep (clean contacts are not visited)", async () => {
    const db = fakeDb({
      topicCache: { "digest:w": "tp_1" },
      contacts: [
        { email: "dirty@x.com", id: 1, dirty: true },
        { email: "clean@x.com", id: 2, dirty: false },
      ],
    });
    const { handle, spies } = fakeResend({
      topicsByEmail: { "dirty@x.com": [{ id: "tp_1", subscription: "opt_in" }] },
    });
    const envoy = makeEnvoy(db.pool, handle);

    const res = await reconcile(envoy, { mode: "dirty", sleepFn: noSleep });
    expect(res.processed).toBe(1);
    expect(res.reconciled).toBe(1);
    // Only the dirty contact's topics were listed.
    expect(spies.topicsList).toHaveBeenCalledTimes(1);
    expect(spies.topicsList).toHaveBeenCalledWith({ email: "dirty@x.com", after: undefined });
  });

  it("full-sweep resumes via its own cursor across ticks", async () => {
    const seed: FakeDbSeed = {
      topicCache: {},
      contacts: [
        { email: "c1@x.com", id: 1 },
        { email: "c2@x.com", id: 2 },
        { email: "c3@x.com", id: 3 },
      ],
    };
    const db = fakeDb(seed);
    const { handle } = fakeResend({
      topicsByEmail: {
        "c1@x.com": [],
        "c2@x.com": [],
        "c3@x.com": [],
      },
    });
    const envoy = makeEnvoy(db.pool, handle);

    // Tick 1: budget 2 → processes c1,c2; persists cursor "2".
    const t1 = await reconcile(envoy, { mode: "full", maxContacts: 2, sleepFn: noSleep });
    expect(t1.processed).toBe(2);
    expect(t1.resumeCursor).toBe("2");
    expect(db.sweep.cursor).toBe("2");

    // Tick 2: resumes after id 2 → processes c3 (1 < budget) → reaches end → cursor reset to null.
    const t2 = await reconcile(envoy, { mode: "full", maxContacts: 2, sleepFn: noSleep });
    expect(t2.processed).toBe(1);
    expect(t2.resumeCursor).toBeNull();
    expect(db.sweep.cursor).toBeNull();
  });

  it("Error: one contact's 429 pauses the rest of the tick and resumes next tick", async () => {
    const db = fakeDb({
      topicCache: { "digest:w": "tp_1" },
      contacts: [
        { email: "first@x.com", id: 1, dirty: true },
        { email: "second@x.com", id: 2, dirty: true },
      ],
    });
    // first@ throws a 429 on list; the sweep should stop before reaching second@.
    const topicsList = vi.fn(async ({ email }: { email: string }) => {
      if (email === "first@x.com") throw { statusCode: 429, name: "rate_limit" };
      return { data: { object: "list", data: [], has_more: false }, error: null };
    });
    const segmentAdd = vi.fn(async () => ({ data: { id: "s" }, error: null }));
    const handle = createResendClientHandle("re_test_key");
    vi.spyOn(handle, "client").mockReturnValue({
      contacts: { topics: { list: topicsList }, segments: { add: segmentAdd } },
    } as never);
    const envoy = makeEnvoy(db.pool, handle);

    const res = await reconcile(envoy, { mode: "dirty", backoffMs: 1, sleepFn: noSleep });
    expect(res.rateLimited).toBe(true);
    expect(res.processed).toBe(1); // stopped after the rate-limited contact
    // second@ was never listed.
    expect(topicsList).toHaveBeenCalledTimes(1);
    // Both contacts remain dirty (neither was cleared).
    expect(db.contacts.get("first@x.com")?.dirty).toBe(true);
    expect(db.contacts.get("second@x.com")?.dirty).toBe(true);
  });

  it("full-sweep: a 429 on the LAST budget contact persists the PREVIOUS id (does not skip the un-reconciled contact)", async () => {
    // Full sweep, budget 2 → reads c1, c2. c1 reconciles; c2 hits a 429 and the sweep breaks. The
    // resume cursor MUST be c1's id (1), NOT c2's id (2): if it persisted 2, the next full cycle
    // would resume after id 2 and SKIP the rate-limited c2 for the entire cycle — a PAUSED contact
    // silently dropped from reconciliation.
    const db = fakeDb({
      topicCache: { "digest:w": "tp_1" },
      contacts: [
        { email: "c1@x.com", id: 1 },
        { email: "c2@x.com", id: 2 },
        { email: "c3@x.com", id: 3 },
      ],
    });
    const topicsList = vi.fn(async ({ email }: { email: string }) => {
      if (email === "c2@x.com") throw { statusCode: 429, name: "rate_limit" };
      return { data: { object: "list", data: [], has_more: false }, error: null };
    });
    const segmentAdd = vi.fn(async () => ({ data: { id: "s" }, error: null }));
    const handle = createResendClientHandle("re_test_key");
    vi.spyOn(handle, "client").mockReturnValue({
      contacts: { topics: { list: topicsList }, segments: { add: segmentAdd } },
    } as never);
    const envoy = makeEnvoy(db.pool, handle);

    const res = await reconcile(envoy, { mode: "full", maxContacts: 2, backoffMs: 1, sleepFn: noSleep });
    expect(res.rateLimited).toBe(true);
    expect(res.processed).toBe(2); // both visited
    // The resume cursor stayed at c1 (the last FULLY reconciled contact), NOT c2 (un-reconciled).
    expect(res.resumeCursor).toBe("1");
    expect(db.sweep.cursor).toBe("1");
  });

  it("full-sweep: a per-contact ERROR does not advance the resume cursor onto the errored contact", async () => {
    // Full sweep, budget 1, single contact c1 that ERRORS (non-429). The sweep continues (no break)
    // but must NOT advance the resume cursor onto the errored contact: it stays revisitable. With
    // only c1 in the budget and no later contact to move the cursor, the persisted cursor stays at
    // the start (null) so the next full cycle revisits c1.
    const db = fakeDb({
      topicCache: {},
      contacts: [{ email: "err@x.com", id: 1 }],
    });
    const { handle } = fakeResend({ listThrows: { statusCode: 500, name: "internal" } });
    const envoy = makeEnvoy(db.pool, handle);

    const res = await reconcile(envoy, { mode: "full", maxContacts: 1, sleepFn: noSleep });
    expect(res.processed).toBe(1);
    // Budget-worth processed (1 === maxContacts) so reachedEnd is false → cursor persisted as lastId,
    // which was NOT advanced onto the errored contact → stays at the start (null).
    expect(res.resumeCursor).toBeNull();
    expect(db.sweep.cursor).toBeNull();
  });

  it("collects unmapped contacts into the sweep result (surfaced for the host)", async () => {
    const db = fakeDb({
      topicCache: { "digest:w": "tp_1" },
      contacts: [{ email: "leak@x.com", id: 1, dirty: true }],
    });
    const { handle } = fakeResend({
      topicsByEmail: { "leak@x.com": [{ id: "tp_orphan", subscription: "opt_out" }] },
    });
    const envoy = makeEnvoy(db.pool, handle);

    const res = await reconcile(envoy, { mode: "dirty", sleepFn: noSleep });
    expect(res.unmapped).toHaveLength(1);
    expect(res.unmapped[0]!.email).toBe("leak@x.com");
    expect(res.unmapped[0]!.unmappedTopicIds).toEqual(["tp_orphan"]);
    expect(res.reconciled).toBe(0);
  });

  it("skips corrupt topic-cache rows (empty id / unparseable key) — they surface as unmapped, not mapped", async () => {
    const base = fakeDb({
      topicCache: {},
      contacts: [{ email: "z@x.com", id: 1, dirty: true }],
    });
    // Override ONLY the program_state topic-cache read to return corrupt rows; everything else uses
    // the real fake. tp_x's key has no `digest:`/`alert:` stream prefix, so it must be excluded from
    // the reverse map (and therefore surface as unmapped when Resend reports it on the contact).
    const realQuery = base.pool.query;
    base.pool.query = vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      const t = text.trim();
      if (
        t.startsWith("SELECT subject_key, watermark FROM sdk_program_state") &&
        params?.[1] === "__envoy_topics__"
      ) {
        return {
          rows: [
            { subject_key: "digest:ok", watermark: "" }, // empty id → skipped from the map
            { subject_key: "no-stream-prefix", watermark: "tp_x" }, // bad key → skipped from the map
          ],
        } as never;
      }
      return realQuery(text, params);
    }) as never;

    const { handle } = fakeResend({
      topicsByEmail: { "z@x.com": [{ id: "tp_x", subscription: "opt_out" }] },
    });
    const envoy = makeEnvoy(base.pool, handle);

    const res = await reconcile(envoy, { mode: "dirty", sleepFn: noSleep });
    // tp_x's cache row was excluded (corrupt key) → it surfaces as unmapped, never silently mapped.
    expect(res.unmapped).toHaveLength(1);
    expect(res.unmapped[0]!.unmappedTopicIds).toEqual(["tp_x"]);
  });
});

// =============================================================================================
// Integration: a clean dirty-set sweep clears dirty and writes the opt_out diff end-to-end.
// =============================================================================================

describe("reconcile integration", () => {
  it("converges mirror↔Resend: opt_out written, segment repaired, dirty cleared", async () => {
    const db = fakeDb({
      topicCache: { "digest:weekly": "tp_1", "alert:law": "tp_2" },
      contacts: [{ email: "i@x.com", id: 1, dirty: true }],
      consent: [
        {
          contact: NS("i@x.com"),
          topic_key: "digest:weekly",
          topic_id: "tp_1",
          digest_status: "opt_in",
          alert_status: "opt_in",
          dirty: false,
        },
      ],
    });
    const { handle, spies } = fakeResend({
      topicsByEmail: {
        "i@x.com": [
          { id: "tp_1", subscription: "opt_out" }, // drift: opted out on Resend's page
          { id: "tp_2", subscription: "opt_in" },
        ],
      },
    });
    const envoy = makeEnvoy(db.pool, handle);

    const res = await reconcile(envoy, { mode: "dirty", sleepFn: noSleep });
    expect(res.processed).toBe(1);
    expect(res.reconciled).toBe(1);
    expect(res.unmapped).toEqual([]);
    expect(db.consent.get(`${NS("i@x.com")}|digest:weekly`)?.digest_status).toBe("opt_out");
    expect(spies.segmentAdd).toHaveBeenCalledWith({ email: "i@x.com", segmentId: "seg_base" });
    expect(db.contacts.get("i@x.com")?.dirty).toBe(false);
  });
});
