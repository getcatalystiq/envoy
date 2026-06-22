import { describe, expect, it, vi } from "vitest";

import {
  enroll,
  deleteContact,
  createSegmentSync,
  SegmentSync,
} from "@sdk/contacts.js";
import { createDb, normalizeEmail, type SdkPool } from "@sdk/db/pool.js";
import { createConsentMirror } from "@sdk/consent/mirror.js";
import { createResendClientHandle } from "@sdk/resend/client.js";
import type { ResendClientHandle } from "@sdk/resend/client.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";

// ---------------------------------------------------------------------------------------------
// In-memory fake of the Postgres slice U7 (contacts.ts + topics.ts) touches. It models:
//   - sdk_contacts upsert (data merge, monotonic unsubscribed) + RETURNING unsubscribed
//   - sdk_contacts dirty-stamp / suppress / set resend_contact_id / SELECT resend_contact_id
//   - sdk_enrollments claim (ON CONFLICT DO NOTHING RETURNING) + SELECT
//   - sdk_program_state topic-id cache (claim-or-read), same shape as topics.ts uses
// Keyed maps; records every statement for assertions. Mirrors the test fakes in mirror.test.ts.
// ---------------------------------------------------------------------------------------------

interface ContactStore {
  email: string;
  data: Record<string, unknown>;
  unsubscribed: boolean;
  resend_contact_id: string | null;
  dirty: boolean;
}
interface EnrollStore {
  contact: string;
  sequence_key: string;
  status: string;
  current_step: number;
  data?: Record<string, unknown>;
}

const NAMESPACE = "prod";

interface ConsentStore {
  contact: string; // namespaced key (e.g. "prod:a@example.com")
  topic_key: string;
  topic_id: string | null;
  digest_status: "opt_in" | "opt_out" | "unsubscribed";
  alert_status: "opt_in" | "opt_out" | "unsubscribed";
  dirty_since: string | null;
}

const CONSENT_RANK_MAP: Record<string, number> = {
  opt_in: 0,
  opt_out: 1,
  unsubscribed: 2,
};

function fakePool(seed?: {
  contacts?: ContactStore[];
  topicCache?: Record<string, string>;
  consent?: ConsentStore[];
  enrollments?: EnrollStore[];
}) {
  const contacts = new Map<string, ContactStore>(); // email -> row
  const enrollments = new Map<string, EnrollStore>(); // contact::seq -> row
  const topicCache = new Map<string, string>(); // ns|program|subject -> id
  const consent = new Map<string, ConsentStore>(); // contact::topic_key -> row
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];

  for (const c of seed?.contacts ?? []) contacts.set(c.email, { ...c });
  for (const [k, v] of Object.entries(seed?.topicCache ?? {})) topicCache.set(k, v);
  for (const r of seed?.consent ?? []) consent.set(`${r.contact}::${r.topic_key}`, { ...r });
  for (const e of seed?.enrollments ?? [])
    enrollments.set(`${e.contact}::${e.sequence_key}`, { ...e });

  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();
      const p = params ?? [];

      // --- sdk_contacts upsert (RETURNING unsubscribed) ---
      if (t.startsWith("INSERT INTO sdk_contacts")) {
        const [, email, dataJson] = p as [string, string, string];
        const incoming = JSON.parse(dataJson) as Record<string, unknown>;
        const existing = contacts.get(email);
        if (!existing) {
          const row: ContactStore = {
            email,
            data: incoming,
            unsubscribed: false,
            resend_contact_id: null,
            dirty: false,
          };
          contacts.set(email, row);
          return { rows: [{ unsubscribed: false }] } as never;
        }
        existing.data = { ...existing.data, ...incoming }; // shallow merge, new keys win
        return { rows: [{ unsubscribed: existing.unsubscribed }] } as never;
      }

      // --- sdk_contacts dirty-stamp ---
      if (t.startsWith("UPDATE sdk_contacts SET dirty_since = NOW()")) {
        const [, email] = p as [string, string];
        const row = contacts.get(email);
        if (row) row.dirty = true;
        return { rows: row ? [{}] : [] } as never;
      }

      // --- deleteContact erasure — ONE atomic CTE (P2 GDPR): suppress sdk_contacts, null the
      //     enrollment data snapshot, clear step PII, AND fan the suppression into consent, all in
      //     a single statement. Params: [namespace, lower(email), namespacedContact].
      if (
        t.startsWith("WITH enr_ids AS (") &&
        /UPDATE sdk_steps/.test(t) &&
        /UPDATE sdk_enrollments/.test(t) &&
        /UPDATE sdk_contacts/.test(t) &&
        /UPDATE sdk_topic_consent/.test(t)
      ) {
        const [, email, nsContact] = p as [string, string, string];
        // suppress the contact
        const crow = contacts.get(email);
        if (crow) {
          crow.unsubscribed = true;
          crow.dirty = true;
        }
        // null the enrollment data snapshot + fan suppression into consent
        for (const row of enrollments.values()) {
          if (row.contact.toLowerCase() === String(nsContact).toLowerCase()) {
            (row as EnrollStore & { data?: unknown }).data = {};
          }
        }
        for (const row of consent.values()) {
          if (row.contact.toLowerCase() === String(nsContact).toLowerCase()) {
            row.digest_status = "unsubscribed";
            row.alert_status = "unsubscribed";
            row.dirty_since = "now";
          }
        }
        // sdk_steps PII clear is modeled as a no-op on this store (no step rows tracked here).
        return { rows: [] } as never;
      }

      // --- sdk_contacts suppress ---
      if (t.startsWith("UPDATE sdk_contacts SET unsubscribed = TRUE")) {
        const [, email] = p as [string, string];
        const row = contacts.get(email);
        if (row) {
          row.unsubscribed = true;
          row.dirty = true;
        }
        return { rows: row ? [{}] : [] } as never;
      }

      // --- sdk_contacts set resend_contact_id ---
      if (t.startsWith("UPDATE sdk_contacts SET resend_contact_id")) {
        const [, email, rid] = p as [string, string, string];
        const row = contacts.get(email);
        if (row) row.resend_contact_id = rid;
        return { rows: row ? [{}] : [] } as never;
      }

      // --- sdk_contacts SELECT resend_contact_id ---
      if (t.startsWith("SELECT resend_contact_id FROM sdk_contacts")) {
        const [, email] = p as [string, string];
        const row = contacts.get(email);
        return {
          rows: row ? [{ resend_contact_id: row.resend_contact_id }] : [],
        } as never;
      }

      // --- sdk_enrollments claim ---
      if (t.startsWith("INSERT INTO sdk_enrollments")) {
        const [, contact, seq] = p as [string, string, string];
        const key = `${contact}::${seq}`;
        if (enrollments.has(key)) {
          return { rows: [] } as never; // lost claim (already enrolled)
        }
        const row: EnrollStore = { contact, sequence_key: seq, status: "active", current_step: 0 };
        enrollments.set(key, row);
        return { rows: [{ status: row.status, current_step: row.current_step }] } as never;
      }

      // --- sdk_enrollments SELECT ---
      if (t.startsWith("SELECT status, current_step FROM sdk_enrollments")) {
        const [, contact, seq] = p as [string, string, string];
        const row = enrollments.get(`${contact}::${seq}`);
        return {
          rows: row ? [{ status: row.status, current_step: row.current_step }] : [],
        } as never;
      }

      // --- sdk_program_state topic cache: SELECT ---
      if (t.startsWith("SELECT watermark FROM sdk_program_state")) {
        const v = topicCache.get(`${p[0]}|${p[1]}|${p[2]}`);
        return { rows: v !== undefined ? [{ watermark: v }] : [] } as never;
      }

      // --- sdk_program_state topic cache: claim ---
      if (t.startsWith("INSERT INTO sdk_program_state")) {
        const k = `${p[0]}|${p[1]}|${p[2]}`;
        if (topicCache.has(k)) return { rows: [] } as never;
        topicCache.set(k, p[3] as string);
        return { rows: [{ watermark: p[3] }] } as never;
      }

      // --- sdk_topic_consent upsert (monotonic merge, RETURNING) — what enroll()'s consent seed
      //     and consent.set issue. Models the SQL CASE merge in JS so the REAL mirror.set path runs.
      if (t.startsWith("INSERT INTO sdk_topic_consent")) {
        const [, contact, topicKey, topicId, wantDigest, wantAlert] = p as [
          string,
          string,
          string,
          string | null,
          "opt_in" | "opt_out" | "unsubscribed" | null,
          "opt_in" | "opt_out" | "unsubscribed" | null,
        ];
        const key = `${contact}::${topicKey}`;
        const existing = consent.get(key);
        const rank = (s: string | null) => (s === null ? -1 : CONSENT_RANK_MAP[s] ?? -1);
        if (!existing) {
          const row: ConsentStore = {
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
        if (wantDigest !== null && rank(wantDigest) >= rank(existing.digest_status)) {
          existing.digest_status = wantDigest;
        }
        if (wantAlert !== null && rank(wantAlert) >= rank(existing.alert_status)) {
          existing.alert_status = wantAlert;
        }
        existing.topic_id = topicId ?? existing.topic_id;
        existing.dirty_since = "now";
        return { rows: [{ ...existing }] } as never;
      }

      // --- sdk_topic_consent SELECT (mirror.read / gate) ---
      if (t.startsWith("SELECT contact, topic_key")) {
        const [, contact, topicKey] = p as [string, string, string];
        const row = consent.get(`${contact}::${topicKey}`);
        return { rows: row ? [{ ...row }] : [] } as never;
      }

      // --- sdk_topic_consent dirty-clear ---
      if (t.startsWith("UPDATE sdk_topic_consent SET dirty_since = NULL")) {
        const [, contact, topicKey] = p as [string, string, string];
        const row = consent.get(`${contact}::${topicKey}`);
        if (row) row.dirty_since = null;
        return { rows: [] } as never;
      }

      // --- sdk_topic_consent fan-out (suppressMirror raises every row to unsubscribed) ---
      if (t.startsWith("UPDATE sdk_topic_consent") && /digest_status = 'unsubscribed'/.test(t)) {
        const [, nsContact] = p as [string, string];
        for (const row of consent.values()) {
          if (row.contact.toLowerCase() === String(nsContact).toLowerCase()) {
            row.digest_status = "unsubscribed";
            row.alert_status = "unsubscribed";
            row.dirty_since = "now";
          }
        }
        return { rows: [] } as never;
      }

      // --- sdk_contacts global-suppression read (gate.isGloballySuppressed) ---
      if (t.startsWith("SELECT unsubscribed FROM sdk_contacts")) {
        const [, email] = p as [string, string];
        // email is already lowercased by the caller; contacts are keyed by the email they were
        // stored with — match case-insensitively to mirror `lower(email) = $2`.
        let found: ContactStore | undefined;
        for (const row of contacts.values()) {
          if (row.email.toLowerCase() === String(email).toLowerCase()) {
            found = row;
            break;
          }
        }
        return { rows: found ? [{ unsubscribed: found.unsubscribed }] : [] } as never;
      }

      // --- sdk_enrollments PII purge (deleteContact → purgeContactPii) ---
      if (t.startsWith("UPDATE sdk_enrollments") && /data = '\{\}'::jsonb/.test(t)) {
        const [, nsContact] = p as [string, string];
        for (const row of enrollments.values()) {
          if (row.contact.toLowerCase() === String(nsContact).toLowerCase()) {
            // model the data wipe on the EnrollStore (extended below with an optional `data` field)
            (row as EnrollStore & { data?: unknown }).data = {};
          }
        }
        return { rows: [] } as never;
      }

      // --- sdk_steps PII purge (deleteContact → purgeContactPii) ---
      if (t.startsWith("UPDATE sdk_steps") && /last_error = NULL/.test(t)) {
        return { rows: [] } as never;
      }

      return { rows: [] } as never;
    }),
  };

  return { pool, contacts, enrollments, topicCache, consent, calls };
}

// ---------------------------------------------------------------------------------------------
// Fake Resend whose contacts.{create,remove,segments,topics} + topics.create are controllable spies.
// ---------------------------------------------------------------------------------------------

interface ResendSpyOpts {
  enabled?: boolean;
  contactCreateError?: boolean;
  contactCreateThrows?: boolean;
  segmentAddError?: boolean;
  topicUpdateError?: boolean;
  topicCreateError?: boolean;
  contactRemoveError?: boolean;
  contactRemoveThrows?: boolean;
  segmentRemoveError?: boolean;
}

function fakeResend(opts: ResendSpyOpts = {}): {
  handle: ResendClientHandle;
  spies: {
    contactCreate: ReturnType<typeof vi.fn>;
    contactRemove: ReturnType<typeof vi.fn>;
    segmentAdd: ReturnType<typeof vi.fn>;
    segmentRemove: ReturnType<typeof vi.fn>;
    topicUpdate: ReturnType<typeof vi.fn>;
    topicCreate: ReturnType<typeof vi.fn>;
  };
} {
  const err = (m: string) => ({ message: m, statusCode: 422, name: "validation_error" });

  let n = 0;
  const contactCreate = vi.fn(async () => {
    if (opts.contactCreateThrows) throw new Error("network");
    if (opts.contactCreateError) return { data: null, error: err("create failed") };
    n += 1;
    return { data: { id: `ct_${n}` }, error: null };
  });
  const contactRemove = vi.fn(async () => {
    if (opts.contactRemoveThrows) throw new Error("network");
    return { data: opts.contactRemoveError ? null : { object: "contact", deleted: true, contact: "x" }, error: opts.contactRemoveError ? err("remove failed") : null };
  });
  const segmentAdd = vi.fn(async () => ({
    data: opts.segmentAddError ? null : { id: "seg_add" },
    error: opts.segmentAddError ? err("seg add failed") : null,
  }));
  const segmentRemove = vi.fn(async () => ({
    data: opts.segmentRemoveError ? null : { id: "seg_rm", deleted: true },
    error: opts.segmentRemoveError ? err("seg rm failed") : null,
  }));
  const topicUpdate = vi.fn(async () => ({
    data: opts.topicUpdateError ? null : { id: "ct_topic" },
    error: opts.topicUpdateError ? err("topic update failed") : null,
  }));
  let tn = 0;
  const topicCreate = vi.fn(async () => {
    if (opts.topicCreateError) return { data: null, error: err("topic create failed") };
    tn += 1;
    return { data: { id: `tp_${tn}` }, error: null };
  });

  const handle = createResendClientHandle(opts.enabled === false ? undefined : "re_test_key");
  if (opts.enabled !== false) {
    vi.spyOn(handle, "client").mockReturnValue({
      contacts: {
        create: contactCreate,
        remove: contactRemove,
        segments: { add: segmentAdd, remove: segmentRemove },
        topics: { update: topicUpdate },
      },
      topics: { create: topicCreate },
    } as never);
  }
  return {
    handle,
    spies: { contactCreate, contactRemove, segmentAdd, segmentRemove, topicUpdate, topicCreate },
  };
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

function setup(resendOpts?: ResendSpyOpts, seed?: Parameters<typeof fakePool>[0]) {
  const fp = fakePool(seed);
  const { handle, spies } = fakeResend(resendOpts);
  const envoy = makeEnvoy(fp.pool, handle);
  return { envoy, ...fp, spies };
}

// =============================================================================================

describe("createSegmentSync", () => {
  it("returns a SegmentSync", () => {
    const { envoy } = setup();
    expect(createSegmentSync(envoy)).toBeInstanceOf(SegmentSync);
  });
});

describe("enroll — event-driven enrollment (R8, R10, R11)", () => {
  it("Covers R11. Happy: a new enroll upserts the mirror + base Segment + opts the Topic in", async () => {
    const { envoy, contacts, enrollments, spies, topicCache } = setup();

    const res = await enroll(
      envoy,
      { email: "a@example.com", data: { firstName: "Ada" } },
      "welcome",
      { topic: { stream: "digest", subject: "IT" } }
    );

    expect(res.created).toBe(true);
    expect(res.status).toBe("active");
    expect(res.suppressed).toBe(false);
    expect(res.sync?.ok).toBe(true);
    expect(res.sync?.steps).toEqual({
      contact: "confirmed",
      segment: "confirmed",
      topic: "confirmed",
    });

    // Mirror contact created with the host data.
    expect(contacts.get("a@example.com")?.data).toEqual({ firstName: "Ada" });
    // Enrollment row created under the namespaced contact key.
    expect(enrollments.get(`${NAMESPACE}:a@example.com::welcome`)?.status).toBe("active");
    // Resend reflection: global contact create (with base segment), explicit segment add, topic in.
    expect(spies.contactCreate).toHaveBeenCalledTimes(1);
    expect(spies.contactCreate.mock.calls[0][0]).toMatchObject({
      email: "a@example.com",
      segments: [{ id: "seg_base" }],
    });
    expect(spies.segmentAdd).toHaveBeenCalledWith({ email: "a@example.com", segmentId: "seg_base" });
    expect(spies.topicCreate).toHaveBeenCalledTimes(1);
    expect(spies.topicUpdate).toHaveBeenCalledWith({
      email: "a@example.com",
      topics: [{ id: "tp_1", subscription: "opt_in" }],
    });
    // Topic id cached.
    expect(topicCache.get(`${NAMESPACE}|__envoy_topics__|digest:IT`)).toBe("tp_1");
  });

  it("Covers R11. re-enroll of an active contact is a no-op (created:false, no new sync/send)", async () => {
    const { envoy, spies } = setup();

    await enroll(envoy, { email: "a@example.com" }, "welcome", {
      topic: { stream: "digest", subject: "IT" },
    });
    spies.contactCreate.mockClear();
    spies.topicUpdate.mockClear();

    const second = await enroll(envoy, { email: "a@example.com" }, "welcome", {
      topic: { stream: "digest", subject: "IT" },
    });

    expect(second.created).toBe(false);
    expect(second.status).toBe("active");
    expect(second.sync).toBeNull();
    // No new Resend reflection on the idempotent re-enroll.
    expect(spies.contactCreate).not.toHaveBeenCalled();
    expect(spies.topicUpdate).not.toHaveBeenCalled();
  });

  it("a fresh enroll WITHOUT a topic still upserts Contact + base Segment (R10)", async () => {
    const { envoy, spies } = setup();
    const res = await enroll(envoy, { email: "b@example.com" }, "welcome");
    expect(res.sync?.steps.topic).toBe("none");
    expect(res.sync?.ok).toBe(true);
    expect(spies.contactCreate).toHaveBeenCalledTimes(1);
    expect(spies.segmentAdd).toHaveBeenCalledTimes(1);
    expect(spies.topicCreate).not.toHaveBeenCalled();
    expect(spies.topicUpdate).not.toHaveBeenCalled();
  });

  it("Edge: a globally-suppressed contact records the enrollment but performs NO Resend sync", async () => {
    const { envoy, spies } = setup(undefined, {
      contacts: [
        {
          email: "gone@example.com",
          data: {},
          unsubscribed: true,
          resend_contact_id: null,
          dirty: false,
        },
      ],
    });

    const res = await enroll(envoy, { email: "gone@example.com" }, "welcome", {
      topic: { stream: "digest", subject: "IT" },
    });

    expect(res.created).toBe(true);
    expect(res.suppressed).toBe(true);
    expect(res.sync).toBeNull();
    expect(spies.contactCreate).not.toHaveBeenCalled();
    expect(spies.topicUpdate).not.toHaveBeenCalled();
  });

  it("rejects an empty sequenceKey (fail loud, not at send time)", async () => {
    const { envoy } = setup();
    await expect(enroll(envoy, { email: "a@example.com" }, "")).rejects.toThrow(/sequenceKey/);
  });

  it("rejects an empty email (fail loud)", async () => {
    const { envoy } = setup();
    await expect(enroll(envoy, { email: "   " }, "welcome")).rejects.toThrow(/email/);
  });

  it("P1: seeds a LOCAL opt_in consent row for the drip topic so the gate passes (no separate consent.set)", async () => {
    // A bug class: enroll() previously never seeded the local consent row, so the drip gate
    // (mirror.gate) denied EVERY send until the host separately called consent.set. This exercises
    // the REAL mirror.gate against the REAL consent row enroll seeds.
    const { envoy, consent } = setup();

    const res = await enroll(envoy, { email: "drip@example.com" }, "welcome");
    expect(res.created).toBe(true);
    expect(res.suppressed).toBe(false);

    // The seeded consent row is keyed on the namespaced contact + the sequenceKey as the topic,
    // opt_in on the digest stream (the drip lane default).
    const seeded = consent.get(`${NAMESPACE}:drip@example.com::welcome`);
    expect(seeded?.digest_status).toBe("opt_in");

    // The drip gate (topicKey = sequenceKey, stream = digest) now PASSES with no extra consent.set.
    const mirror = createConsentMirror(envoy.db, envoy.resend);
    expect(await mirror.gate("drip@example.com", "welcome", "digest")).toBe(true);
  });

  it("P1: a suppressed contact is NOT consent-seeded (monotonic — no opt_in resurrects an unsub)", async () => {
    const { envoy, consent } = setup(undefined, {
      contacts: [
        {
          email: "gone@example.com",
          data: {},
          unsubscribed: true,
          resend_contact_id: null,
          dirty: false,
        },
      ],
    });

    await enroll(envoy, { email: "gone@example.com" }, "welcome");
    // No opt_in consent row was seeded for the suppressed contact.
    expect(consent.get(`${NAMESPACE}:gone@example.com::welcome`)).toBeUndefined();
  });

  it("Residual: a Mixed.Case enrollment is keyed lowercase so a lowercased suppression converges", async () => {
    const { envoy, contacts, consent } = setup();

    await enroll(envoy, { email: "Mixed.Case@Example.com" }, "welcome");

    // The mirror contact + enrollment + consent seed all key on the lowercased email.
    const lowered = normalizeEmail("Mixed.Case@Example.com");
    expect(contacts.has(lowered)).toBe(true);
    expect(consent.get(`${NAMESPACE}:${lowered}::welcome`)).toBeDefined();

    // The gate matches even when queried with a DIFFERENT case (resolution is case-insensitive).
    const mirror = createConsentMirror(envoy.db, envoy.resend);
    expect(await mirror.gate("MIXED.case@example.COM", "welcome", "digest")).toBe(true);

    // Now a lowercased suppression (as the webhook writes) flips the same contact row; the gate
    // then denies the mixed-case enrollment — the two paths converged on one row.
    contacts.get(lowered)!.unsubscribed = true;
    expect(await mirror.gate("Mixed.Case@Example.com", "welcome", "digest")).toBe(false);
  });
});

describe("SegmentSync.push — push-on-write, fail-soft (R37)", () => {
  it("Edge: a partial push failure (segment add fails) marks the row reconcile-dirty, no throw", async () => {
    const { envoy, contacts, spies } = setup({ segmentAddError: true });
    // seed the contact so the dirty stamp lands on a row
    contacts.set("c@example.com", {
      email: "c@example.com",
      data: {},
      unsubscribed: false,
      resend_contact_id: null,
      dirty: false,
    });

    const sync = createSegmentSync(envoy);
    const res = await sync.push({ email: "c@example.com" });

    expect(res.ok).toBe(false);
    expect(res.dirty).toBe(true);
    expect(res.steps.segment).toBe("failed");
    expect(contacts.get("c@example.com")?.dirty).toBe(true);
    // Confirm fail-soft: the spy was called and we did NOT throw.
    expect(spies.segmentAdd).toHaveBeenCalled();
  });

  it("Edge: a topic update failure marks dirty (fail-soft)", async () => {
    const { envoy, contacts } = setup({ topicUpdateError: true });
    contacts.set("d@example.com", {
      email: "d@example.com",
      data: {},
      unsubscribed: false,
      resend_contact_id: null,
      dirty: false,
    });
    const res = await createSegmentSync(envoy).push({
      email: "d@example.com",
      topic: { stream: "digest", subject: "FR" },
    });
    expect(res.ok).toBe(false);
    expect(res.dirty).toBe(true);
    expect(res.steps.topic).toBe("failed");
    expect(contacts.get("d@example.com")?.dirty).toBe(true);
  });

  it("a thrown transport error on contact create is fail-soft (marks dirty, no throw)", async () => {
    const { envoy, contacts } = setup({ contactCreateThrows: true });
    contacts.set("e@example.com", {
      email: "e@example.com",
      data: {},
      unsubscribed: false,
      resend_contact_id: null,
      dirty: false,
    });
    const res = await createSegmentSync(envoy).push({ email: "e@example.com" });
    expect(res.ok).toBe(false);
    expect(res.steps.contact).toBe("failed");
    expect(contacts.get("e@example.com")?.dirty).toBe(true);
  });

  it("Edge: unset RESEND_API_KEY makes push a silent no-op (dirty for reconcile, no Resend calls)", async () => {
    const { envoy, contacts, spies } = setup({ enabled: false });
    contacts.set("f@example.com", {
      email: "f@example.com",
      data: {},
      unsubscribed: false,
      resend_contact_id: null,
      dirty: false,
    });
    const res = await createSegmentSync(envoy).push({
      email: "f@example.com",
      topic: { stream: "digest", subject: "IT" },
    });
    expect(res.ok).toBe(false);
    expect(res.dirty).toBe(true);
    expect(res.steps).toEqual({ contact: "skipped", segment: "skipped", topic: "skipped" });
    // No Resend client calls at all.
    expect(spies.contactCreate).not.toHaveBeenCalled();
    expect(spies.segmentAdd).not.toHaveBeenCalled();
    expect(spies.topicCreate).not.toHaveBeenCalled();
    expect(contacts.get("f@example.com")?.dirty).toBe(true);
  });

  it("persists the Resend contact id onto the mirror after a successful create", async () => {
    const { envoy, contacts } = setup();
    contacts.set("g@example.com", {
      email: "g@example.com",
      data: {},
      unsubscribed: false,
      resend_contact_id: null,
      dirty: false,
    });
    await createSegmentSync(envoy).push({ email: "g@example.com" });
    expect(contacts.get("g@example.com")?.resend_contact_id).toBe("ct_1");
  });
});

describe("deleteContact — right-to-erasure, suppress-before-delete (R34)", () => {
  it("Covers R34. Happy: suppresses mirror FIRST, then removes Resend Contact + membership", async () => {
    const { envoy, contacts, spies, calls } = setup(undefined, {
      contacts: [
        {
          email: "del@example.com",
          data: {},
          unsubscribed: false,
          resend_contact_id: "ct_99",
          dirty: false,
        },
      ],
    });

    const res = await deleteContact(envoy, "del@example.com", { topicIds: ["tp_1"] });

    expect(res.suppressed).toBe(true);
    expect(res.resendContactId).toBe("ct_99");
    expect(res.resendContactDeleted).toBe("deleted");
    expect(res.segmentMembershipRemoved).toBe("removed");
    expect(res.topicMembershipCleared).toBe("cleared");

    // Mirror suppressed.
    expect(contacts.get("del@example.com")?.unsubscribed).toBe(true);

    // ORDERING: the atomic erasure (suppress + PII wipe + consent fan-out, ONE CTE) must precede
    // the Resend remove call. Assert it ran before the SELECT of the resend id (which itself
    // precedes the remove). The suppress is now embedded in the `WITH enr_ids AS (...)` statement.
    const suppressIdx = calls.findIndex(
      (c) =>
        c.text.trim().startsWith("WITH enr_ids AS (") &&
        /UPDATE sdk_contacts\s+SET unsubscribed = TRUE/.test(c.text)
    );
    const selectIdx = calls.findIndex((c) =>
      c.text.trim().startsWith("SELECT resend_contact_id FROM sdk_contacts")
    );
    expect(suppressIdx).toBeGreaterThanOrEqual(0);
    expect(suppressIdx).toBeLessThan(selectIdx);

    // Resend teardown happened.
    expect(spies.segmentRemove).toHaveBeenCalledWith({ email: "del@example.com", segmentId: "seg_base" });
    expect(spies.topicUpdate).toHaveBeenCalledWith({
      email: "del@example.com",
      topics: [{ id: "tp_1", subscription: "opt_out" }],
    });
    expect(spies.contactRemove).toHaveBeenCalledWith("del@example.com");
  });

  it("Error: a Resend contact-remove failure is fail-soft (suppression still recorded, no throw)", async () => {
    const { envoy, contacts } = setup({ contactRemoveError: true }, {
      contacts: [
        {
          email: "del@example.com",
          data: {},
          unsubscribed: false,
          resend_contact_id: "ct_1",
          dirty: false,
        },
      ],
    });

    const res = await deleteContact(envoy, "del@example.com");
    expect(res.suppressed).toBe(true);
    expect(res.resendContactDeleted).toBe("failed");
    // Mirror suppression persisted despite the Resend failure.
    expect(contacts.get("del@example.com")?.unsubscribed).toBe(true);
  });

  it("Error: a thrown transport error on remove is fail-soft", async () => {
    const { envoy } = setup({ contactRemoveThrows: true }, {
      contacts: [
        {
          email: "x@example.com",
          data: {},
          unsubscribed: false,
          resend_contact_id: "ct_1",
          dirty: false,
        },
      ],
    });
    const res = await deleteContact(envoy, "x@example.com");
    expect(res.resendContactDeleted).toBe("failed");
    expect(res.suppressed).toBe(true);
  });

  it("Edge: Resend unset → mirror suppressed, no upstream teardown attempted", async () => {
    const { envoy, contacts, spies } = setup({ enabled: false }, {
      contacts: [
        {
          email: "y@example.com",
          data: {},
          unsubscribed: false,
          resend_contact_id: null,
          dirty: false,
        },
      ],
    });
    const res = await deleteContact(envoy, "y@example.com");
    expect(res.suppressed).toBe(true);
    expect(res.resendContactDeleted).toBe("skipped");
    expect(res.segmentMembershipRemoved).toBe("skipped");
    expect(res.topicMembershipCleared).toBe("skipped");
    expect(contacts.get("y@example.com")?.unsubscribed).toBe(true);
    expect(spies.contactRemove).not.toHaveBeenCalled();
  });

  it("rejects an empty email", async () => {
    const { envoy } = setup();
    await expect(deleteContact(envoy, "")).rejects.toThrow(/non-empty email/);
  });

  it("P2 GDPR: purges the contact's enrollment data snapshot (PII erasure, not just suppression)", async () => {
    const { envoy, enrollments, calls } = setup(undefined, {
      contacts: [
        {
          email: "pii@example.com",
          data: { ssn: "secret" },
          unsubscribed: false,
          resend_contact_id: null,
          dirty: false,
        },
      ],
      // Seed an enrollment carrying PII in its data snapshot (namespaced contact, as enroll writes).
      enrollments: [
        {
          contact: `${NAMESPACE}:pii@example.com`,
          sequence_key: "welcome",
          status: "active",
          current_step: 0,
          data: { firstName: "Real", ssn: "123-45-6789" },
        },
      ],
    });

    const res = await deleteContact(envoy, "pii@example.com");
    expect(res.piiPurged).toBe(true);

    // The enrollment data snapshot was wiped to an empty object — no residual PII.
    const enr = enrollments.get(`${NAMESPACE}:pii@example.com::welcome`);
    expect(enr?.data).toEqual({});

    // P2: erasure is ONE atomic statement. A single data-modifying CTE suppresses the contact,
    // nulls the enrollment data snapshot, clears step PII, AND fans suppression into consent —
    // so a crash can never leave the contact half-erased while we still report piiPurged: true.
    const erasureWrites = calls.filter(
      (c) =>
        c.text.trim().startsWith("WITH enr_ids AS (") &&
        /data = '\{\}'::jsonb/.test(c.text) &&
        /last_error = NULL/.test(c.text) &&
        /UPDATE sdk_contacts/.test(c.text) &&
        /UPDATE sdk_topic_consent/.test(c.text),
    );
    expect(erasureWrites).toHaveLength(1);

    // And there is NO standalone enrollment-data null / step-PII clear that isn't the atomic CTE.
    const standaloneEnrollmentPurge = calls.filter(
      (c) =>
        c.text.trim().startsWith("UPDATE sdk_enrollments") && /data = '\{\}'::jsonb/.test(c.text),
    );
    expect(standaloneEnrollmentPurge).toHaveLength(0);
  });

  it("P1: a globally-suppressed (bounced) contact is denied by the gate on BOTH lanes", async () => {
    // A contact whose global `unsubscribed` flag is set (bounce/complaint/GDPR/hosted-page) must be
    // denied on every topic/stream — INCLUDING a topic that still carries a stale opt_in consent row
    // (the gate previously read only the per-topic row and would have allowed it).
    const { envoy } = setup(undefined, {
      contacts: [
        {
          email: "bounced@example.com",
          data: {},
          unsubscribed: true,
          resend_contact_id: null,
          dirty: false,
        },
      ],
      // A stale opt_in consent row on both streams — the per-topic state alone would say "allow".
      consent: [
        {
          contact: `${NAMESPACE}:bounced@example.com`,
          topic_key: "welcome",
          topic_id: null,
          digest_status: "opt_in",
          alert_status: "opt_in",
          dirty_since: null,
        },
      ],
    });

    const mirror = createConsentMirror(envoy.db, envoy.resend);
    expect(await mirror.gate("bounced@example.com", "welcome", "digest")).toBe(false);
    expect(await mirror.gate("bounced@example.com", "welcome", "alert")).toBe(false);
  });
});
