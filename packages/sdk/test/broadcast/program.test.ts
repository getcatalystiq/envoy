import { afterEach, describe, expect, it, vi } from "vitest";

import {
  defineBroadcastProgram,
  BroadcastProgramError,
  type RenderContext,
  type RenderedIssue,
} from "@sdk/broadcast/program.js";
import { clearTemplateCache } from "@sdk/resend/templates.js";
import { createDb, type SdkPool } from "@sdk/db/pool.js";
import type { ResendClientHandle } from "@sdk/resend/client.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";

// =================================================================================================
// In-memory fake of the Postgres slice `runIssue` touches, across the four tables its primitives
// hit. The whole canonical ordering (reconcile → claim → render → send → advance) is exercised
// end-to-end against ONE fake pool that models EXACTLY the statements each primitive issues:
//
//   sdk_program_state
//     - SELECT watermark, issue_seq, last_fired_at, paused …            (cursor.read)
//     - INSERT … ON CONFLICT … DO UPDATE … WHERE <strictly-greater>     (cursor.advance)
//     - SELECT subject_key, watermark … program_key = __envoy_topics__  (reconcile topic-cache read)
//     - SELECT watermark … program_key = __envoy_topics__               (provisionTopic read)
//     - INSERT … ON CONFLICT DO NOTHING RETURNING … __envoy_topics__    (provisionTopic write)
//   sdk_contacts
//     - SELECT id, email … dirty_since IS NOT NULL                      (reconcile dirty page)
//   sdk_broadcast_claims
//     - INSERT … ON CONFLICT DO NOTHING RETURNING …                     (claim)
//     - SELECT … FROM sdk_broadcast_claims                              (claim read-back)
//     - UPDATE … SET resend_broadcast_id = $3 …                         (persistBroadcastId)
//     - UPDATE … SET sent_at = NOW() …                                  (markSent)
//
// Rows are returned with NO `rowCount` (Neon HTTP driver shape) so a primitive reading rowCount
// would fail. Reconcile is kept a near no-op by seeding ZERO dirty contacts in most tests — the
// reconcile primitive has its own dedicated U14 suite; here we only assert it RAN in order.
// =================================================================================================

const NAMESPACE = "prod";
const NS_SEP = ":";
const NS = (key: string) => `${NAMESPACE}${NS_SEP}${key}`;
const NUMERIC = /^[0-9.eE+-]+$/;

function storageStrictlyGreater(incoming: string, current: string | null): boolean {
  if (current === null) return true;
  if (NUMERIC.test(incoming) && NUMERIC.test(current)) return Number(incoming) > Number(current);
  return incoming > current;
}

interface StateRow {
  watermark: string | null;
  issue_seq: number;
  last_fired_at: string | null;
  paused: boolean;
}
interface ClaimRow {
  broadcast_key: string;
  resend_broadcast_id: string | null;
  item_ids: string[];
  sent_at: string | null;
  created_at: string;
}

interface FakeDbSeed {
  /** Pre-seed a cursor row for a bare subjectKey (under program key, namespaced internally). */
  cursor?: { programKey: string; subjectKey: string; row: Partial<StateRow> };
  /** Pre-seed the topic-id provisioning cache: topicKey ("stream:subject") -> topicId. */
  topicCache?: Record<string, string>;
  /** Pre-seed a broadcast claim row by bare broadcastKey. */
  claims?: Record<string, Partial<ClaimRow>>;
  /** dirty contacts (drive reconcile to actually visit someone — usually empty). */
  dirtyContacts?: Array<{ id: number; email: string }>;
}

function fakeDb(seed: FakeDbSeed = {}) {
  // sdk_program_state keyed by `${ns}|${program_key}|${subject_key}`.
  const state = new Map<string, StateRow>();
  const claims = new Map<string, ClaimRow>(); // `${ns}|${broadcast_key}` (stored = namespaced)
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];
  const now = () => new Date().toISOString();
  const k3 = (ns: unknown, pk: unknown, sk: unknown) => `${ns}|${pk}|${sk}`;

  if (seed.cursor) {
    const { programKey, subjectKey, row } = seed.cursor;
    // cursor.ts namespaces BOTH the program key and the subject key (db.namespaceKey on each).
    state.set(k3(NAMESPACE, NS(programKey), NS(subjectKey)), {
      watermark: row.watermark ?? null,
      issue_seq: row.issue_seq ?? 0,
      last_fired_at: row.last_fired_at ?? null,
      paused: row.paused ?? false,
    });
  }
  for (const [topicKey, topicId] of Object.entries(seed.topicCache ?? {})) {
    state.set(k3(NAMESPACE, "__envoy_topics__", topicKey), {
      watermark: topicId,
      issue_seq: 0,
      last_fired_at: null,
      paused: false,
    });
  }
  for (const [bk, row] of Object.entries(seed.claims ?? {})) {
    claims.set(`${NAMESPACE}|${NS(bk)}`, {
      broadcast_key: NS(bk),
      resend_broadcast_id: row.resend_broadcast_id ?? null,
      item_ids: row.item_ids ?? [],
      sent_at: row.sent_at ?? null,
      created_at: row.created_at ?? now(),
    });
  }
  const dirty = seed.dirtyContacts ?? [];

  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();
      const p = params ?? [];

      // --- reconcile: topic-cache full read (subject_key, watermark) ---
      if (
        t.startsWith("SELECT subject_key, watermark FROM sdk_program_state") &&
        p[1] === "__envoy_topics__"
      ) {
        const rows = [...state.entries()]
          .filter(([key]) => key.startsWith(`${NAMESPACE}|__envoy_topics__|`))
          .map(([key, v]) => ({ subject_key: key.split("|")[2], watermark: v.watermark }));
        return { rows } as never;
      }

      // --- reconcile: dirty-contacts page ---
      if (t.startsWith("SELECT id, email FROM sdk_contacts")) {
        return { rows: dirty.map((c) => ({ id: c.id, email: c.email })) } as never;
      }

      // --- provisionTopic / cursor: single-row program_state read ---
      if (t.startsWith("SELECT watermark FROM sdk_program_state")) {
        const found = state.get(k3(p[0], p[1], p[2]));
        return { rows: found ? [{ watermark: found.watermark }] : [] } as never;
      }
      if (
        t.startsWith("SELECT watermark, issue_seq, last_fired_at, paused") &&
        t.includes("FROM sdk_program_state")
      ) {
        const found = state.get(k3(p[0], p[1], p[2]));
        if (!found) return { rows: [] } as never;
        return {
          rows: [
            {
              watermark: found.watermark,
              issue_seq: found.issue_seq,
              last_fired_at: found.last_fired_at,
              paused: found.paused,
            },
          ],
        } as never;
      }

      // --- provisionTopic: cache claim INSERT (single $4 watermark, DO NOTHING) ---
      if (
        t.startsWith("INSERT INTO sdk_program_state") &&
        p[1] === "__envoy_topics__" &&
        t.includes("DO NOTHING")
      ) {
        const key = k3(p[0], p[1], p[2]);
        if (state.has(key)) return { rows: [] } as never;
        state.set(key, {
          watermark: (p[3] as string) ?? null,
          issue_seq: 0,
          last_fired_at: null,
          paused: false,
        });
        return { rows: [{ watermark: p[3] }] } as never;
      }

      // --- cursor.advance: INSERT … ON CONFLICT … DO UPDATE … WHERE <strictly-greater> ---
      if (
        t.startsWith("INSERT INTO sdk_program_state") &&
        t.includes("issue_seq") &&
        t.includes("last_fired_at")
      ) {
        const key = k3(p[0], p[1], p[2]);
        const incoming = p[3] as string;
        const issueSeq = Number(p[4]);
        const firedAt = (p[5] as string | undefined) ?? now();
        const existing = state.get(key);
        if (!existing) {
          state.set(key, {
            watermark: incoming,
            issue_seq: issueSeq,
            last_fired_at: firedAt,
            paused: false,
          });
          return {
            rows: [
              { watermark: incoming, issue_seq: issueSeq, last_fired_at: firedAt, paused: false },
            ],
          } as never;
        }
        if (storageStrictlyGreater(incoming, existing.watermark)) {
          existing.watermark = incoming;
          existing.issue_seq = issueSeq;
          existing.last_fired_at = firedAt;
          return {
            rows: [
              {
                watermark: existing.watermark,
                issue_seq: existing.issue_seq,
                last_fired_at: existing.last_fired_at,
                paused: existing.paused,
              },
            ],
          } as never;
        }
        return { rows: [] } as never; // guard rejected — concurrent racer advanced past us
      }

      // --- claim: INSERT … ON CONFLICT DO NOTHING RETURNING ---
      if (t.startsWith("INSERT INTO sdk_broadcast_claims")) {
        const key = `${p[0]}|${p[1]}`;
        if (claims.has(key)) return { rows: [] } as never;
        const row: ClaimRow = {
          broadcast_key: p[1] as string,
          resend_broadcast_id: null,
          item_ids: (p[2] as string[]) ?? [],
          sent_at: null,
          created_at: now(),
        };
        claims.set(key, row);
        return { rows: [{ ...row }] } as never;
      }
      if (t.startsWith("SELECT") && t.includes("FROM sdk_broadcast_claims")) {
        const found = claims.get(`${p[0]}|${p[1]}`);
        return { rows: found ? [{ ...found }] : [] } as never;
      }
      if (t.startsWith("UPDATE sdk_broadcast_claims") && t.includes("resend_broadcast_id = $3")) {
        const found = claims.get(`${p[0]}|${p[1]}`);
        if (!found) return { rows: [] } as never;
        found.resend_broadcast_id = p[2] as string;
        return { rows: [{ ...found }] } as never;
      }
      if (t.startsWith("UPDATE sdk_broadcast_claims") && t.includes("sent_at = NOW()")) {
        const found = claims.get(`${p[0]}|${p[1]}`);
        if (!found) return { rows: [] } as never;
        found.sent_at = now();
        const incoming = p[2] as string[] | null;
        if (incoming !== null) found.item_ids = incoming;
        return { rows: [{ ...found }] } as never;
      }

      return { rows: [] } as never;
    }),
  };

  return { pool, calls, state, claims };
}

// --- Resend fake: templates.get + broadcasts.create + broadcasts.list -----------------------------

function fakeResend(opts?: {
  enabled?: boolean;
  templateHtml?: string;
  templateText?: string | null;
  createError?: { message?: string } | null;
  createId?: string;
  listPages?: Array<Array<{ id: string; name: string; created_at: string }>>;
}): {
  handle: ResendClientHandle;
  create: ReturnType<typeof vi.fn>;
  get: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
} {
  const enabled = opts?.enabled ?? true;
  const pages = opts?.listPages ?? [];
  let pageIdx = 0;

  const get = vi.fn(async (_id: string) => ({
    data: {
      id: "tmpl_1",
      html: opts?.templateHtml ?? "<p>Hi {{ name }} — {{{RESEND_UNSUBSCRIBE_URL}}}</p>",
      text: opts?.templateText === undefined ? "Hi {{ name }}" : opts.templateText,
      variables: [{ key: "name", fallback_value: "there", type: "string" as const }],
    },
    error: null,
  }));
  const create = vi.fn(async (_payload: Record<string, unknown>) => ({
    data: opts?.createError ? null : { id: opts?.createId ?? "bcast_1" },
    error: opts?.createError ?? null,
  }));
  const list = vi.fn(async (_o?: { limit?: number; after?: string }) => {
    const data = pages[pageIdx] ?? [];
    const has_more = pageIdx < pages.length - 1;
    pageIdx += 1;
    return { data: { data, has_more }, error: null };
  });

  const client = { templates: { get }, broadcasts: { create, list } };
  const handle: ResendClientHandle = {
    enabled,
    client: () => (enabled ? (client as never) : null),
  };
  return { handle, create, get, list };
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
    redact: (v: unknown) => (String(v).includes("re_") ? "***" : `redacted:${String(v)}`),
  };
}

// A minimal valid render that always sends, naming a numeric watermark.
function alwaysRender(watermark = "100"): RenderedIssue {
  return { templateId: "tmpl_1", subject: "Weekly", variables: { name: "Ada" }, watermark };
}

// Templates are cached install-wide; clear between tests so a re-fetch assertion is meaningful.
afterEach(() => {
  clearTemplateCache();
  vi.restoreAllMocks();
});

// =================================================================================================
// defineBroadcastProgram — definition-time validation (fail loud)
// =================================================================================================

describe("defineBroadcastProgram — definition validation", () => {
  it("returns a frozen handle with config + bound key helpers", () => {
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      render: () => alwaysRender(),
    });
    expect(program.key).toBe("weekly");
    expect(program.segmentId).toBe("seg_1");
    expect(program.cadenceDays).toBe(7);
    expect(program.cursorKey("IT")).toEqual({ programKey: "weekly", subjectKey: "IT" });
    expect(program.broadcastKey("IT", 3)).toBe("weekly:IT:3");
    expect(program.topicFor("IT")).toEqual({ stream: "digest", subject: "IT" });
    expect(Object.isFrozen(program)).toBe(true);
  });

  it("honors a custom topicKeyFor", () => {
    const program = defineBroadcastProgram({
      key: "alerts",
      segmentId: "seg_1",
      cadenceDays: 1,
      topicKeyFor: (s) => ({ stream: "alert", subject: `law-${s}` }),
      render: () => alwaysRender(),
    });
    expect(program.topicFor("EU")).toEqual({ stream: "alert", subject: "law-EU" });
  });

  it.each([
    ["missing key", { key: "", segmentId: "s", cadenceDays: 7, render: () => alwaysRender() }],
    ["missing segmentId", { key: "w", segmentId: "", cadenceDays: 7, render: () => alwaysRender() }],
    ["zero cadence", { key: "w", segmentId: "s", cadenceDays: 0, render: () => alwaysRender() }],
    ["negative cadence", { key: "w", segmentId: "s", cadenceDays: -1, render: () => alwaysRender() }],
    ["NaN cadence", { key: "w", segmentId: "s", cadenceDays: NaN, render: () => alwaysRender() }],
  ])("throws on %s", (_label, input) => {
    // Values are type-valid (empty strings, 0/-1/NaN) but violate the runtime contract — they must
    // fail loud at definition time.
    expect(() => defineBroadcastProgram(input)).toThrow(BroadcastProgramError);
  });

  it("throws when render is not a function", () => {
    expect(() =>
      // @ts-expect-error — render missing
      defineBroadcastProgram({ key: "w", segmentId: "s", cadenceDays: 7 })
    ).toThrow(/render function/);
  });

  it("throws when a non-object is passed", () => {
    // @ts-expect-error — null input
    expect(() => defineBroadcastProgram(null)).toThrow(BroadcastProgramError);
  });

  it("throws when topicKeyFor returns an invalid stream at resolve time", () => {
    const program = defineBroadcastProgram({
      key: "w",
      segmentId: "s",
      cadenceDays: 7,
      // @ts-expect-error — bad stream
      topicKeyFor: () => ({ stream: "marketing", subject: "x" }),
      render: () => alwaysRender(),
    });
    expect(() => program.topicFor("x")).toThrow(/invalid stream/);
  });
});

// =================================================================================================
// runIssue — Happy: reconcile → claim → render → send → advance, in order; a held claim sends once.
// (Covers R35 happy path.)
// =================================================================================================

describe("runIssue — canonical ordering (R35 happy)", () => {
  it("runs reconcile → claim → render → send → advance in order and sends once", async () => {
    const { pool, calls } = fakeDb({ topicCache: { "digest:default": "tp_1" } });
    const resend = fakeResend({ createId: "bcast_42" });
    const envoy = makeEnvoy(pool, resend.handle);

    const order: string[] = [];
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "news@acme.test",
      render: (ctx: RenderContext) => {
        order.push("render");
        expect(ctx.subjectKey).toBe("default");
        expect(ctx.topicId).toBe("tp_1");
        expect(ctx.items).toEqual([{ id: "n1" }]);
        return { templateId: "tmpl_1", subject: "Weekly", variables: { name: "Ada" }, watermark: "100", itemIds: ["n1"] };
      },
    });

    const res = await program.runIssue(envoy, { items: [{ id: "n1" }], force: true });

    expect(res.sent).toBe(true);
    expect(res.broadcastId).toBe("bcast_42");
    expect(res.skipped).toBeUndefined();
    expect(res.failed).toBeUndefined();
    expect(res.broadcastKey).toBe("weekly:default:1");
    expect(res.reconcile).toBeDefined();
    expect(res.cursor?.watermark).toBe("100");
    expect(res.cursor?.issueSeq).toBe(1);

    // broadcasts.create called with the program's segment + provisioned topic, no templateId/headers.
    expect(resend.create).toHaveBeenCalledTimes(1);
    const payload = resend.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.segmentId).toBe("seg_1");
    expect(payload.topicId).toBe("tp_1");
    expect(payload.from).toBe("news@acme.test");
    expect(payload.name).toBe("weekly:default:1");
    expect(payload.send).toBe(true);
    expect(payload.templateId).toBeUndefined();
    expect(payload.headers).toBeUndefined();

    // Ordering: the reconcile read (topic cache / dirty page) precedes the claim INSERT, which
    // precedes broadcasts.create, which precedes the cursor.advance INSERT and markSent UPDATE.
    const texts = calls.map((c) => c.text.trim());
    const idxDirty = texts.findIndex((t) => t.startsWith("SELECT id, email FROM sdk_contacts"));
    const idxClaim = texts.findIndex((t) => t.startsWith("INSERT INTO sdk_broadcast_claims"));
    const idxAdvance = texts.findIndex(
      (t) => t.startsWith("INSERT INTO sdk_program_state") && t.includes("issue_seq")
    );
    const idxMarkSent = texts.findIndex(
      (t) => t.startsWith("UPDATE sdk_broadcast_claims") && t.includes("sent_at = NOW()")
    );
    const createCallIdx = order.indexOf("render");
    expect(idxDirty).toBeGreaterThanOrEqual(0);
    expect(idxDirty).toBeLessThan(idxClaim); // reconcile ran before claim
    expect(idxClaim).toBeLessThan(idxAdvance); // claim before advance
    expect(idxMarkSent).toBeLessThan(idxAdvance); // markSent before advance (send finalized first)
    expect(createCallIdx).toBeGreaterThanOrEqual(0);
  });

  it("a second runIssue for the same already-sent issue does NOT re-send (send-once)", async () => {
    // Seed a completed claim for weekly:default:1, and a cursor already advanced to seq 1 / wm 100.
    const { pool } = fakeDb({
      topicCache: { "digest:default": "tp_1" },
      claims: { "weekly:default:1": { resend_broadcast_id: "bcast_1", sent_at: "2026-06-20T00:00:00Z" } },
      cursor: { programKey: "weekly", subjectKey: "default", row: { watermark: "100", issue_seq: 1, last_fired_at: "2026-06-20T00:00:00Z" } },
    });
    const resend = fakeResend();
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "news@acme.test",
      // render returns seq 1 again (a duplicate trigger) — the claim guard catches it.
      render: () => ({ templateId: "tmpl_1", subject: "Weekly", watermark: "100", issueSeq: 1 }),
    });

    const res = await program.runIssue(envoy, { force: true });
    expect(res.sent).toBe(false);
    expect(res.skipped).toBe("already_sent");
    expect(res.broadcastId).toBe("bcast_1");
    expect(resend.create).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// runIssue — cadence + pause gating (no send when not due / paused / empty)
// =================================================================================================

describe("runIssue — gating (cadence / pause / empty)", () => {
  it("skips with not_due inside the cadence window", async () => {
    const fixedNow = Date.parse("2026-06-21T00:00:00Z");
    const { pool } = fakeDb({
      topicCache: { "digest:default": "tp_1" },
      cursor: {
        programKey: "weekly",
        subjectKey: "default",
        row: { watermark: "100", issue_seq: 1, last_fired_at: "2026-06-20T00:00:00Z" }, // 1 day ago
      },
    });
    const resend = fakeResend();
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      render: () => alwaysRender(),
    });

    const res = await program.runIssue(envoy, { now: () => fixedNow });
    expect(res.sent).toBe(false);
    expect(res.skipped).toBe("not_due");
    expect(res.reconcile).toBeUndefined(); // gated before reconcile
    expect(resend.create).not.toHaveBeenCalled();
  });

  it("sends after the cadence window elapses", async () => {
    const fixedNow = Date.parse("2026-06-30T00:00:00Z"); // 10 days after last fire
    const { pool } = fakeDb({
      topicCache: { "digest:default": "tp_1" },
      cursor: {
        programKey: "weekly",
        subjectKey: "default",
        row: { watermark: "100", issue_seq: 1, last_fired_at: "2026-06-20T00:00:00Z" },
      },
    });
    const resend = fakeResend({ createId: "bcast_2" });
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "news@acme.test",
      render: () => alwaysRender("200"),
    });

    const res = await program.runIssue(envoy, { now: () => fixedNow });
    expect(res.sent).toBe(true);
    expect(res.cursor?.watermark).toBe("200");
    expect(res.cursor?.issueSeq).toBe(2);
  });

  it("never sends when paused (even with force)", async () => {
    const { pool } = fakeDb({
      topicCache: { "digest:default": "tp_1" },
      cursor: { programKey: "weekly", subjectKey: "default", row: { paused: true } },
    });
    const resend = fakeResend();
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      render: () => alwaysRender(),
    });

    const res = await program.runIssue(envoy, { force: true });
    expect(res.skipped).toBe("paused");
    expect(resend.create).not.toHaveBeenCalled();
  });

  it("skips with empty when render returns null (no new content)", async () => {
    const { pool } = fakeDb({ topicCache: { "digest:default": "tp_1" } });
    const resend = fakeResend();
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      render: (ctx) => (ctx.items.length === 0 ? null : alwaysRender()),
    });

    const res = await program.runIssue(envoy, { items: [], force: true });
    expect(res.sent).toBe(false);
    expect(res.skipped).toBe("empty");
    // reconcile + topic provisioning DID run (render is after them); only the send/advance did not.
    expect(res.reconcile).toBeDefined();
    expect(resend.create).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// runIssue — Error: a fresh concurrent claim loss skips without sending.
// =================================================================================================

describe("runIssue — concurrent claim loss (R35 error)", () => {
  it("a lost claim that is NOT resumable (already sent) skips without sending", async () => {
    const { pool } = fakeDb({
      topicCache: { "digest:default": "tp_1" },
      claims: { "weekly:default:1": { resend_broadcast_id: "bcast_x", sent_at: "2026-06-20T00:00:00Z" } },
    });
    const resend = fakeResend();
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "f@x.test",
      render: () => ({ templateId: "tmpl_1", subject: "W", watermark: "100", issueSeq: 1 }),
    });

    const res = await program.runIssue(envoy, { force: true });
    expect(res.sent).toBe(false);
    expect(res.skipped).toBe("already_sent");
    expect(resend.create).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// runIssue — Error: per-subject fail-soft — one subject's Resend failure does not throw.
// =================================================================================================

describe("runIssue — per-subject fail-soft (R35 error)", () => {
  it("a Resend broadcasts.create error is captured as failed, not thrown; cursor does NOT advance", async () => {
    const { pool, state } = fakeDb({ topicCache: { "digest:default": "tp_1" } });
    const resend = fakeResend({ createError: { message: "resend 500" } });
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "f@x.test",
      render: () => alwaysRender("100"),
    });

    const res = await program.runIssue(envoy, { force: true });
    expect(res.sent).toBe(false);
    expect(res.failed).toBeDefined();
    expect(res.failed).not.toContain("re_test_key"); // redacted (R43)
    expect(res.skipped).toBeUndefined();
    // The cursor never advanced — its state row was never written (still the lazy default).
    const stateRow = state.get(`${NAMESPACE}|${NS("weekly")}|${NS("default")}`);
    expect(stateRow).toBeUndefined();
  });

  it("one subject's failure does not abort a host loop over multiple subjects", async () => {
    const { pool } = fakeDb({
      topicCache: { "digest:good": "tp_good", "digest:bad": "tp_bad" },
    });
    // A Resend whose create fails ONLY for the 'bad' subject (by topicId in the payload).
    const create = vi.fn(async (payload: Record<string, unknown>) => {
      if (payload.topicId === "tp_bad") return { data: null, error: { message: "boom" } };
      return { data: { id: "bcast_ok" }, error: null };
    });
    const get = vi.fn(async () => ({
      data: { id: "tmpl_1", html: "<p>{{ name }}</p>", text: null, variables: [] },
      error: null,
    }));
    const handle: ResendClientHandle = {
      enabled: true,
      client: () => ({ templates: { get }, broadcasts: { create, list: vi.fn() } }) as never,
    };
    const envoy = makeEnvoy(pool, handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "f@x.test",
      topicKeyFor: (s) => ({ stream: "digest", subject: s }),
      render: (ctx) => ({ templateId: "tmpl_1", subject: `Issue ${ctx.subjectKey}`, watermark: "100" }),
    });

    const results = [];
    for (const subjectKey of ["good", "bad"]) {
      // Host loop: a failure on 'bad' must not throw out of the loop.
      results.push(await program.runIssue(envoy, { subjectKey, force: true }));
    }
    expect(results[0]!.sent).toBe(true);
    expect(results[0]!.broadcastId).toBe("bcast_ok");
    expect(results[1]!.sent).toBe(false);
    expect(results[1]!.failed).toBeDefined();
  });
});

// =================================================================================================
// runIssue — crash-resume: a held (resumable) claim with a persisted id finalizes without re-creating.
// =================================================================================================

describe("runIssue — crash-resume of a held claim", () => {
  it("a resumable claim whose Resend id was persisted finalizes (markSent + advance) without re-creating", async () => {
    const { pool } = fakeDb({
      topicCache: { "digest:default": "tp_1" },
      // A prior attempt won the claim, created the broadcast, persisted the id, then crashed BEFORE
      // markSent. sent_at IS NULL ⇒ resumable; resend_broadcast_id present ⇒ resolve reads it.
      claims: { "weekly:default:1": { resend_broadcast_id: "bcast_persisted" } },
    });
    const resend = fakeResend();
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "f@x.test",
      render: () => ({ templateId: "tmpl_1", subject: "W", watermark: "100", issueSeq: 1 }),
    });

    const res = await program.runIssue(envoy, { force: true });
    expect(res.sent).toBe(true);
    expect(res.broadcastId).toBe("bcast_persisted");
    expect(resend.create).not.toHaveBeenCalled(); // resumed, did NOT re-create (R30 no double-blast)
    expect(resend.list).not.toHaveBeenCalled(); // persisted id ⇒ no list scan
    expect(res.cursor?.watermark).toBe("100");
    expect(res.cursor?.issueSeq).toBe(1);
  });

  it("a resumable claim whose id is ABSENT and whose broadcast does not exist re-sends (safe re-create)", async () => {
    const { pool } = fakeDb({
      topicCache: { "digest:default": "tp_1" },
      // Crashed BEFORE persisting the id; the precheck list returns NO match ⇒ absent ⇒ safe to send.
      claims: { "weekly:default:1": { resend_broadcast_id: null } },
    });
    const resend = fakeResend({ createId: "bcast_resent", listPages: [[]] }); // empty list page → absent
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "f@x.test",
      render: () => ({ templateId: "tmpl_1", subject: "W", watermark: "100", issueSeq: 1 }),
    });

    const res = await program.runIssue(envoy, { force: true });
    expect(resend.list).toHaveBeenCalled(); // precheck ran (id absent)
    expect(resend.create).toHaveBeenCalledTimes(1); // absent ⇒ re-create
    expect(res.sent).toBe(true);
    expect(res.broadcastId).toBe("bcast_resent");
  });

  it("a resume precheck budget-exhaustion is captured as failed (fail-soft at the program layer)", async () => {
    // id absent + a list that always returns full pages of NON-matching, NEWER-than-claim entries so
    // the precheck never falls below the lower bound and exhausts its page budget → primitive throws.
    const newer = () => new Date(Date.now() + 60_000).toISOString();
    const page = Array.from({ length: 100 }, (_v, i) => ({
      id: `b${i}`,
      name: "someone-else",
      created_at: newer(),
    }));
    const listPages = Array.from({ length: 30 }, () => page); // more than DEFAULT_PRECHECK_MAX_PAGES
    const { pool } = fakeDb({
      topicCache: { "digest:default": "tp_1" },
      claims: { "weekly:default:1": { resend_broadcast_id: null } },
    });
    const resend = fakeResend({ listPages });
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "f@x.test",
      render: () => ({ templateId: "tmpl_1", subject: "W", watermark: "100", issueSeq: 1 }),
    });

    const res = await program.runIssue(envoy, { force: true, resume: { retries: 0, retryDelayMs: 0 } });
    expect(res.sent).toBe(false);
    expect(res.failed).toBeDefined(); // budget exhaustion captured, not thrown
    expect(resend.create).not.toHaveBeenCalled(); // never blind-re-created
  });
});

// =================================================================================================
// runIssue — render-contract validation (host mistakes fail loud)
// =================================================================================================

describe("runIssue — render-contract validation", () => {
  it("throws (not fail-soft) when render returns a null watermark — a nullable ordering column", async () => {
    const { pool } = fakeDb({ topicCache: { "digest:default": "tp_1" } });
    const resend = fakeResend();
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "f@x.test",
      // @ts-expect-error — deliberately bad watermark
      render: () => ({ templateId: "tmpl_1", subject: "W", watermark: null }),
    });

    await expect(program.runIssue(envoy, { force: true })).rejects.toThrow(/watermark/);
    expect(resend.create).not.toHaveBeenCalled();
  });

  it("throws when no from address is available (program.from unset and render omits it)", async () => {
    const { pool } = fakeDb({ topicCache: { "digest:default": "tp_1" } });
    const resend = fakeResend();
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      render: () => ({ templateId: "tmpl_1", subject: "W", watermark: "100" }),
    });

    await expect(program.runIssue(envoy, { force: true })).rejects.toThrow(/from address/);
  });

  it("render-supplied from overrides the program default", async () => {
    const { pool } = fakeDb({ topicCache: { "digest:default": "tp_1" } });
    const resend = fakeResend({ createId: "bcast_z" });
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "default@x.test",
      render: () => ({ templateId: "tmpl_1", subject: "W", watermark: "100", from: "override@x.test" }),
    });

    await program.runIssue(envoy, { force: true });
    const payload = resend.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.from).toBe("override@x.test");
  });
});

// =================================================================================================
// runIssue — fan-out subjects use distinct cursors + topics
// =================================================================================================

describe("runIssue — fan-out over subjects", () => {
  it("advances a per-subject cursor independently and targets a per-subject topic", async () => {
    const { pool, state } = fakeDb({
      topicCache: { "digest:IT": "tp_it", "digest:FR": "tp_fr" },
    });
    const resend = fakeResend({ createId: "b" });
    const envoy = makeEnvoy(pool, resend.handle);
    const program = defineBroadcastProgram({
      key: "weekly",
      segmentId: "seg_1",
      cadenceDays: 7,
      from: "f@x.test",
      render: (ctx) => ({ templateId: "tmpl_1", subject: `Issue ${ctx.subjectKey}`, watermark: ctx.subjectKey === "IT" ? "10" : "20" }),
    });

    await program.runIssue(envoy, { subjectKey: "IT", force: true });
    await program.runIssue(envoy, { subjectKey: "FR", force: true });

    const it = state.get(`${NAMESPACE}|${NS("weekly")}|${NS("IT")}`);
    const fr = state.get(`${NAMESPACE}|${NS("weekly")}|${NS("FR")}`);
    expect(it?.watermark).toBe("10");
    expect(fr?.watermark).toBe("20");

    const topics = resend.create.mock.calls.map((c) => (c[0] as Record<string, unknown>).topicId);
    expect(topics).toEqual(["tp_it", "tp_fr"]);
  });
});

// =================================================================================================
// runIssue — raw primitives remain available alongside the convenience
// =================================================================================================

describe("U15 — raw primitives stay exported", async () => {
  it("the package root still exports the raw broadcast primitives", async () => {
    const mod = await import("@sdk/index.js");
    for (const name of [
      "claim",
      "markSent",
      "persistBroadcastId",
      "resolveResumeBroadcastId",
      "reconcile",
      "sendBroadcast",
      "renderBroadcast",
      "readCursor",
      "advanceCursor",
      "cursorDue",
      "defineBroadcastProgram",
    ]) {
      expect(typeof (mod as Record<string, unknown>)[name]).toBe("function");
    }
  });
});
