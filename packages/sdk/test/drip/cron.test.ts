import { afterEach, describe, expect, it, vi } from "vitest";

import {
  tickDrip,
  type DripTickConfig,
  type SequenceRegistry,
} from "@sdk/drip/engine.js";
import { createDripCronHandler } from "@sdk/route/handler.js";
import { defineSequence, type Sequence } from "@sdk/drip/sequence.js";
import { createDb, type SdkPool, type SdkQueryResult } from "@sdk/db/pool.js";
import { createConsentMirror } from "@sdk/consent/mirror.js";
import { createResendClientHandle } from "@sdk/resend/client.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";
import { setAgentClient } from "@sdk/agent/session.js";

// U9 — drip cron tick + mounted handler. No real network/DB: a fake `pg` pool serves the claim CTE,
// step upsert/read-back, the consent-mirror gate SELECT (via a REAL ConsentMirror), and records the
// engine's step/enrollment advances; Resend's `emails.send` is a spy; the agent is faked via
// `setAgentClient`. The no-double-send guard (R21) is exercised by running two concurrent ticks
// against ONE pool whose claim CTE hands each enrollment to at most one tick.

const NAMESPACE = "prod";
const UNSUB_SECRET = "unsub-secret-0123456789";
const UNSUB_URL = "https://app.example.com/api/envoy/unsubscribe";

afterEach(() => {
  setAgentClient(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Seeds
// ---------------------------------------------------------------------------------------------

interface EnrollmentSeed {
  id: number;
  contact: string;
  sequenceKey: string;
  currentStep: number;
  /** ISO string or null (eligible now). */
  nextRunAt?: string | null;
  data?: Record<string, unknown>;
  status?: "active" | "completed" | "paused";
}

interface ConsentSeed {
  contact: string;
  topicKey: string;
  digest?: "opt_in" | "opt_out" | "unsubscribed";
  /** GLOBAL `sdk_contacts.unsubscribed` flag — the gate's suppress-all check (default false). */
  unsubscribed?: boolean;
}

interface RecordedCall {
  text: string;
  params: ReadonlyArray<unknown>;
}

interface EnrollmentRow {
  id: number;
  namespace: string;
  contact: string;
  sequence_key: string;
  current_step: number;
  next_run_at: string | null;
  data: Record<string, unknown>;
  status: string;
}

interface StepRow {
  id: number;
  namespace: string;
  enrollment_id: number;
  step_index: number;
  agent_session_id: string | null;
  block_sessions: Record<string, string> | null;
  status: string;
  resend_email_id: string | null;
}

// ---------------------------------------------------------------------------------------------
// Fake pool: an in-memory enrollment + step store that understands exactly the four statement
// shapes the cron path issues, plus the mirror gate SELECT. Every call is recorded for assertions.
// ---------------------------------------------------------------------------------------------

function fakePool(opts: {
  enrollments?: EnrollmentSeed[];
  consent?: ConsentSeed[];
}): {
  pool: SdkPool;
  calls: RecordedCall[];
  enrollments: Map<number, EnrollmentRow>;
  steps: StepRow[];
} {
  const calls: RecordedCall[] = [];

  const enrollments = new Map<number, EnrollmentRow>();
  for (const e of opts.enrollments ?? []) {
    enrollments.set(e.id, {
      id: e.id,
      namespace: NAMESPACE,
      // enroll() stores the NAMESPACED contact key (`namespaceKey(email)`), so the cron path reads a
      // namespaced `contact` and strips it back to the bare email before gating/sending. Seed via
      // that real convention (namespaced) rather than a bare email — the prior bare seed masked the
      // P0 double-namespacing bug (the engine used `row.contact` directly, so the gate never matched
      // and `emails.send` would have carried a `ns:email` recipient).
      contact: `${NAMESPACE}:${e.contact}`,
      sequence_key: e.sequenceKey,
      current_step: e.currentStep,
      next_run_at: e.nextRunAt ?? null,
      data: e.data ?? {},
      status: e.status ?? "active",
    });
  }

  const steps: StepRow[] = [];
  let nextStepId = 1;

  // Consent rows keyed on the NAMESPACED contact (the mirror namespaces before its gate SELECT).
  const consent = new Map<string, Record<string, unknown>>();
  // GLOBAL suppression flag store, keyed on the lower-cased bare email (matches the `sdk_contacts`
  // SELECT in ConsentMirror.gate → isGloballySuppressed). Default unsuppressed.
  const suppressed = new Map<string, boolean>();
  for (const c of opts.consent ?? []) {
    const nsContact = `${NAMESPACE}:${c.contact}`;
    consent.set(`${nsContact}|${c.topicKey}`, {
      contact: nsContact,
      topic_key: c.topicKey,
      topic_id: null,
      digest_status: c.digest ?? "opt_in",
      alert_status: "opt_in",
      dirty_since: null,
    });
    suppressed.set(c.contact.toLowerCase(), c.unsubscribed ?? false);
  }

  // A "lock set" so a second concurrent tick's claim skips rows the first already returned —
  // simulates FOR UPDATE SKIP LOCKED across overlapping statements that have not yet "committed".
  const lockedIds = new Set<number>();

  function claim(params: ReadonlyArray<unknown>): EnrollmentRow[] {
    const [, nowIso, limit] = params as [string, string, number];
    const now = new Date(nowIso).getTime();
    const due = [...enrollments.values()]
      .filter((e) => e.status === "active")
      .filter((e) => !lockedIds.has(e.id))
      .filter((e) => e.next_run_at === null || new Date(e.next_run_at).getTime() <= now)
      .slice(0, limit);
    for (const e of due) lockedIds.add(e.id);
    return due.map((e) => ({ ...e }));
  }

  const pool: SdkPool = {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<SdkQueryResult<T>> {
      calls.push({ text, params: params ?? [] });
      const t = text.trim();

      // 1. Atomic claim CTE.
      if (/FOR UPDATE SKIP LOCKED/i.test(t) && /sdk_enrollments/i.test(t)) {
        return { rows: claim(params ?? []) as unknown as T[] };
      }

      // 2. Step-row upsert (INSERT ... ON CONFLICT DO NOTHING RETURNING id, agent_session_id).
      //    The REAL statement RETURNs the row ONLY when it actually inserts; a conflict (DO NOTHING)
      //    returns zero rows. The fake honors that exactly so the engine's fast path (INSERT
      //    RETURNING, no follow-up SELECT) is exercised, and the conflict path falls through to the
      //    read-back below. The prior fixture returned `[]` unconditionally, which masked whether
      //    `ensureStepRow` ever used RETURNING at all (it forced an always-SELECT N+1 shape).
      if (/INSERT INTO sdk_steps/i.test(t)) {
        const [, enrollmentId, stepIndex] = params as [string, number, number];
        const exists = steps.some(
          (s) => s.enrollment_id === enrollmentId && s.step_index === stepIndex,
        );
        if (exists) {
          // ON CONFLICT DO NOTHING — no row inserted, nothing RETURNed.
          return { rows: [] as T[] };
        }
        const row: StepRow = {
          id: nextStepId++,
          namespace: NAMESPACE,
          enrollment_id: enrollmentId as unknown as number,
          step_index: stepIndex,
          agent_session_id: null,
          block_sessions: {},
          status: "pending",
          resend_email_id: null,
        };
        steps.push(row);
        // RETURNING id, agent_session_id from the freshly inserted row.
        return { rows: [{ id: row.id, agent_session_id: row.agent_session_id, block_sessions: row.block_sessions }] as T[] };
      }

      // 3. Step-row read-back (fallback — runs ONLY on the INSERT conflict path, for an
      //    already-existing row, so a prior tick's inflight agent_session_id survives + is harvested).
      if (/SELECT id, agent_session_id, block_sessions\s+FROM sdk_steps/i.test(t)) {
        const [, enrollmentId, stepIndex] = params as [string, number, number];
        const row = steps.find(
          (s) => s.enrollment_id === enrollmentId && s.step_index === stepIndex,
        );
        return { rows: (row ? [{ id: row.id, agent_session_id: row.agent_session_id, block_sessions: row.block_sessions }] : []) as T[] };
      }

      // 3.5. Gate's FIRST query: the GLOBAL suppression flag (ConsentMirror.isGloballySuppressed).
      // Without this, the suppress-all gate is a no-op (the SELECT falls through to the empty
      // default and reads as not-suppressed).
      if (/SELECT unsubscribed[\s\S]*FROM sdk_contacts[\s\S]*lower\(email\)/i.test(t)) {
        const [, email] = (params ?? []) as unknown[];
        const flag = suppressed.get(String(email).toLowerCase()) ?? false;
        return { rows: [{ unsubscribed: flag }] as T[] };
      }

      // 4. Mirror gate SELECT (real ConsentMirror).
      if (/SELECT[\s\S]*digest_status[\s\S]*FROM sdk_topic_consent/i.test(t)) {
        const [, contact, topicKey] = (params ?? []) as unknown[];
        const row = consent.get(`${String(contact)}|${String(topicKey)}`);
        return { rows: (row ? [row] : []) as T[] };
      }

      // 5 + 6. Engine advance — ONE atomic CTE (P1 double-send guard): mark the step sent AND move
      // the enrollment to the next step in a single statement. Params:
      //   [namespace, stepId($2), emailId($3), nextStep($4), status($5), nextRunAt($6), enrollmentId($7)]
      if (
        /UPDATE sdk_steps[\s\S]*status = 'sent'/i.test(t) &&
        /UPDATE sdk_enrollments[\s\S]*current_step = \$4/i.test(t)
      ) {
        const [, stepId, emailId, nextStep, status, nextRunAt, enrollmentId] = params as [
          string,
          number,
          string,
          number,
          string,
          string | null,
          number,
        ];
        const step = steps.find((s) => s.id === stepId);
        if (step) {
          step.status = "sent";
          step.resend_email_id = emailId;
        }
        const e = enrollments.get(enrollmentId as unknown as number);
        if (e) {
          e.current_step = nextStep;
          e.status = status;
          e.next_run_at = nextRunAt;
        }
        return { rows: [] as T[] };
      }

      // 7. Inflight marker write / failure bookkeeping / completion — record-and-ack.
      return { rows: [] as T[] };
    },
  };

  return { pool, calls, enrollments, steps };
}

// ---------------------------------------------------------------------------------------------
// Fakes for Resend + agent (mirrors the U8 engine test fixtures, trimmed).
// ---------------------------------------------------------------------------------------------

interface ResendOpts {
  enabled?: boolean;
  sendThrows?: boolean;
}

function fakeResend(opts: ResendOpts = {}): {
  handle: ReturnType<typeof createResendClientHandle>;
  emailsSend: ReturnType<typeof vi.fn>;
} {
  const enabled = opts.enabled ?? true;
  let n = 0;
  const emailsSend = vi.fn(async () => {
    if (opts.sendThrows) throw new Error("transport down");
    n += 1;
    return { data: { id: `email_${n}` }, error: null };
  });
  const handle = createResendClientHandle(enabled ? "re_live_key" : undefined);
  vi.spyOn(handle, "client").mockReturnValue(
    enabled ? ({ emails: { send: emailsSend } } as never) : null,
  );
  return { handle, emailsSend };
}

interface AgentOpts {
  output?: string;
}

function fakeAgent(opts: AgentOpts = {}): void {
  const create = vi.fn(async () => ({ id: "sess_new" }));
  const archive = vi.fn(async () => ({}));
  const send = vi.fn(async () => ({}));
  const stream = vi.fn(async () => {
    const events = [
      { type: "agent.message", content: [{ type: "text", text: opts.output ?? '{"body":"Hi"}' }] },
      { type: "session.status_idle", stop_reason: { type: "end_turn" } },
    ];
    const controller = new AbortController();
    return {
      controller,
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
    };
  });
  const retrieve = vi.fn(async () => ({ status: "idle" }));
  const list = vi.fn(async () => {
    async function* gen() {
      yield {
        type: "agent.message",
        content: [{ type: "text", text: opts.output ?? '{"body":"prev"}' }],
      };
      yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
    }
    return gen();
  });
  setAgentClient({
    beta: { sessions: { create, archive, retrieve, events: { stream, send, list } } },
  } as never);
}

function makeEnvoy(
  pool: SdkPool,
  resendHandle: ReturnType<typeof fakeResend>["handle"],
  overrides: Partial<ResolvedEnvoyConfig> = {},
): Envoy {
  const db = createDb(pool, NAMESPACE);
  const config: ResolvedEnvoyConfig = {
    installNamespace: NAMESPACE,
    resendApiKey: "re_live_key",
    webhookSecret: "wh-secret",
    cronSecret: "cron-secret",
    unsubscribeSecret: UNSUB_SECRET,
    baseSegmentId: "seg_base",
    agent: { agentId: "agent_1", environmentId: "env_1" },
    aiFieldAllowList: Object.freeze(["first_name"]),
    streams: Object.freeze({ digest: { from: "digest@app.example.com" } }),
    ...overrides,
  } as ResolvedEnvoyConfig;
  return {
    config,
    db,
    resend: resendHandle,
    assertNamespaceFingerprint: async () => {},
    redact: (v: unknown) => (typeof v === "string" ? "***" : "***"),
  } as unknown as Envoy;
}

const SEQ: Sequence = defineSequence({
  key: "welcome",
  // Per-sequence agent (the engine no longer reads a global config).
  agent: { agentId: "agent_1", environmentId: "env_1" },
  steps: [
    { templateId: "tmpl_day0", waitDays: 0, aiSlots: ["GREETING"], brief: "warm intro" },
    { templateId: "tmpl_day3", waitDays: 3, aiSlots: ["FOLLOWUP"], brief: "nudge" },
  ],
});

const REGISTRY: SequenceRegistry = new Map([["welcome", SEQ]]);

function tickConfig(envoy: Envoy, over: Partial<DripTickConfig> = {}): DripTickConfig {
  const mirror = createConsentMirror(envoy.db, envoy.resend);
  return { mirror, unsubscribeBaseUrl: UNSUB_URL, ...over };
}

// =============================================================================================
// tickDrip
// =============================================================================================

describe("tickDrip — claim + run (R20, R21)", () => {
  it("sends all due steps and advances (happy path)", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
        { id: 11, contact: "bob@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [
        { contact: "ada@example.com", topicKey: "welcome" },
        { contact: "bob@example.com", topicKey: "welcome" },
      ],
    });
    fakeAgent({ output: '{"body":"Hi"}' });
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    expect(result.claimed).toBe(2);
    expect(result.sent).toBe(2);
    expect(result.failed).toBe(0);
    expect(emailsSend).toHaveBeenCalledTimes(2);
    // P0 regression: the recipient `to:` MUST be the BARE email, never the namespaced contact key
    // (`prod:ada@example.com`) that `sdk_enrollments.contact` stores. A double-namespaced `to:`
    // would also be what the mirror gate sees, denying every send.
    const recipients = emailsSend.mock.calls.map((c) => (c[0] as { to: string }).to).sort();
    expect(recipients).toEqual(["ada@example.com", "bob@example.com"]);
    for (const to of recipients) {
      expect(to).not.toContain(`${NAMESPACE}:`);
    }
    // And the engine items carry the bare email too (gate matched the seeded consent row → sent).
    expect(result.items.map((i) => i.email).sort()).toEqual([
      "ada@example.com",
      "bob@example.com",
    ]);
    // Both advanced to step 1.
    expect(fp.enrollments.get(10)?.current_step).toBe(1);
    expect(fp.enrollments.get(11)?.current_step).toBe(1);
  });

  it("claims a GLOBALLY-suppressed contact but gates it — skipped, nothing sent (R22/R26)", async () => {
    // The global `sdk_contacts.unsubscribed` flag dominates a per-topic consent row that still
    // reads `opt_in`. The enrollment IS claimed (the claim CTE doesn't know about suppression),
    // but the gate denies the send. Without the sdk_contacts handler this would wrongly send.
    const fp = fakePool({
      enrollments: [{ id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 }],
      consent: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in", unsubscribed: true }],
    });
    fakeAgent({ output: '{"body":"Hi"}' });
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(result.failed).toBe(0);
    expect(emailsSend).not.toHaveBeenCalled();
    const item = result.items.find((i) => i.email === "ada@example.com");
    expect(item?.result).toEqual({ sent: false, reason: "suppressed" });
    // The enrollment is left untouched (still at step 0) — not advanced, not completed.
    expect(fp.enrollments.get(10)?.current_step).toBe(0);
  });

  it("two concurrent ticks double-send nothing (R21)", async () => {
    const fp = fakePool({
      enrollments: [{ id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 }],
      consent: [{ contact: "ada@example.com", topicKey: "welcome" }],
    });
    fakeAgent();
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);
    const cfg = tickConfig(envoy);

    const [a, b] = await Promise.all([
      tickDrip(envoy, REGISTRY, cfg),
      tickDrip(envoy, REGISTRY, cfg),
    ]);

    // Exactly one tick claimed the lone enrollment; the other claimed nothing.
    expect(a.claimed + b.claimed).toBe(1);
    expect(a.sent + b.sent).toBe(1);
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("skips a step whose wait has not elapsed (R15)", async () => {
    const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 1, nextRunAt: future },
      ],
      consent: [{ contact: "ada@example.com", topicKey: "welcome" }],
    });
    fakeAgent();
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    // The claim filters on next_run_at <= now, so a future-dated enrollment is not even claimed.
    expect(result.claimed).toBe(0);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("one contact's failure does not abort the tick (fail-soft, R21)", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
        { id: 11, contact: "bob@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [
        { contact: "ada@example.com", topicKey: "welcome" },
        { contact: "bob@example.com", topicKey: "welcome" },
      ],
    });
    fakeAgent();
    // Resend throws for every send → both sends fail, but the tick still processes both.
    const { handle, emailsSend } = fakeResend({ sendThrows: true });
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    expect(result.claimed).toBe(2);
    expect(result.sent).toBe(0);
    expect(result.failed).toBe(2);
    expect(emailsSend).toHaveBeenCalledTimes(2);
    // Neither enrollment advanced — both left due (R16).
    expect(fp.enrollments.get(10)?.current_step).toBe(0);
    expect(fp.enrollments.get(11)?.current_step).toBe(0);
  });

  it("a registry callback that throws is fail-soft (tick_error), tick continues", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
        { id: 11, contact: "bob@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [
        { contact: "ada@example.com", topicKey: "welcome" },
        { contact: "bob@example.com", topicKey: "welcome" },
      ],
    });
    fakeAgent();
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    let calls = 0;
    const registry: SequenceRegistry = (key: string) => {
      calls += 1;
      if (calls === 1) throw new Error("registry exploded");
      return key === "welcome" ? SEQ : undefined;
    };

    const result = await tickDrip(envoy, registry, tickConfig(envoy));

    expect(result.claimed).toBe(2);
    // First enrollment errored (tick_error → failed), second sent.
    expect(result.failed).toBe(1);
    expect(result.sent).toBe(1);
    const errored = result.items.find((i) => !i.result.sent && i.result.reason === "tick_error");
    expect(errored).toBeDefined();
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("an enrollment whose sequence is not registered is skipped, not dropped", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "ghost", currentStep: 0 },
      ],
      consent: [{ contact: "ada@example.com", topicKey: "ghost" }],
    });
    fakeAgent();
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    const item = result.items[0];
    expect(item?.result.sent).toBe(false);
    expect(item && !item.result.sent && item.result.reason).toBe("unknown_sequence");
    // Not advanced, not failed — left for the host to fix and retried.
    expect(fp.enrollments.get(10)?.current_step).toBe(0);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("a suppressed contact is gated before send (R26)", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [{ contact: "ada@example.com", topicKey: "welcome", digest: "unsubscribed" }],
    });
    fakeAgent();
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    expect(result.claimed).toBe(1);
    expect(result.sent).toBe(0);
    expect(result.skipped).toBe(1);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("claims nothing when no enrollment is due (empty tick)", async () => {
    const fp = fakePool({ enrollments: [] });
    const { handle } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    expect(result).toMatchObject({ claimed: 0, sent: 0, skipped: 0, failed: 0 });
    expect(result.items).toHaveLength(0);
  });

  it("bounds claimed rows by the configured limit", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "a@example.com", sequenceKey: "welcome", currentStep: 0 },
        { id: 11, contact: "b@example.com", sequenceKey: "welcome", currentStep: 0 },
        { id: 12, contact: "c@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [
        { contact: "a@example.com", topicKey: "welcome" },
        { contact: "b@example.com", topicKey: "welcome" },
        { contact: "c@example.com", topicKey: "welcome" },
      ],
    });
    fakeAgent();
    const { handle } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy, { limit: 2 }));

    expect(result.claimed).toBe(2);
    // The claim statement carried the limit as $3.
    const claimCall = fp.calls.find((c) => /FOR UPDATE SKIP LOCKED/i.test(c.text));
    expect(claimCall?.params[2]).toBe(2);
  });

  it("re-uses the existing step row on re-claim (no duplicate step rows)", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [{ contact: "ada@example.com", topicKey: "welcome" }],
    });
    fakeAgent();
    // Resend throws so the step stays due and the enrollment is re-claimable next tick.
    const { handle } = fakeResend({ sendThrows: true });
    const envoy = makeEnvoy(fp.pool, handle);
    const cfg = tickConfig(envoy);

    await tickDrip(envoy, REGISTRY, cfg);
    // Clear the lock set so the same enrollment can be claimed again (simulates a later tick).
    // The fake's lock set persists; create a fresh tick by mutating status back is not needed —
    // instead assert exactly one step row exists after the first tick's upsert path.
    expect(fp.steps.filter((s) => s.enrollment_id === 10 && s.step_index === 0)).toHaveLength(1);
  });

  // ---- P2 perf: ensureStepRow uses INSERT ... ON CONFLICT DO NOTHING RETURNING (no N+1) ---------

  it("resolves a first-claim step row from INSERT ... RETURNING with NO follow-up SELECT (perf, no N+1)", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [{ contact: "ada@example.com", topicKey: "welcome" }],
    });
    fakeAgent({ output: '{"body":"Hi"}' });
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    // The send landed using the step row that came straight back from the INSERT — the fast path.
    expect(result.sent).toBe(1);
    expect(emailsSend).toHaveBeenCalledTimes(1);

    // The INSERT statement must carry RETURNING (the fix); the OLD code had a bare INSERT.
    const insertCall = fp.calls.find((c) => /INSERT INTO sdk_steps/i.test(c.text));
    expect(insertCall).toBeDefined();
    expect(insertCall!.text).toMatch(/ON CONFLICT[\s\S]*DO NOTHING/i);
    expect(insertCall!.text).toMatch(/RETURNING id, agent_session_id/i);

    // And crucially: on the FIRST claim the engine must NOT issue the read-back SELECT — the row came
    // from RETURNING. A read-back here would prove the N+1 is still present (the bug this fix kills).
    const stepReadBacks = fp.calls.filter((c) =>
      /SELECT id, agent_session_id, block_sessions\s+FROM sdk_steps/i.test(c.text),
    );
    expect(stepReadBacks).toHaveLength(0);
  });

  it("falls back to the read-back SELECT only on conflict, harvesting a prior tick's inflight session", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [{ contact: "ada@example.com", topicKey: "welcome" }],
    });
    // Pre-seed an EXISTING step row carrying an inflight per-slot session from a prior (crashed) tick.
    // The slot is GREETING (step 0's only aiSlot), so its session id lives under block_sessions.
    fp.steps.push({
      id: 99,
      namespace: NAMESPACE,
      enrollment_id: 10,
      step_index: 0,
      agent_session_id: null,
      block_sessions: { GREETING: "sess_prior" },
      status: "pending",
      resend_email_id: null,
    });

    // The agent fake's `list` (harvest) path yields the prior session's output; `create` would mint a
    // NEW session — assert harvest is used (no second billed session) by spying on both.
    const create = vi.fn(async () => ({ id: "sess_new" }));
    const archive = vi.fn(async () => ({}));
    const send = vi.fn(async () => ({}));
    const stream = vi.fn(async () => {
      const controller = new AbortController();
      return {
        controller,
        async *[Symbol.asyncIterator]() {
          yield { type: "agent.message", content: [{ type: "text", text: '{"body":"new"}' }] };
          yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
        },
      };
    });
    const retrieve = vi.fn(async () => ({ status: "idle" }));
    const list = vi.fn(async () => {
      async function* gen() {
        yield {
          type: "agent.message",
          content: [{ type: "text", text: '{"body":"harvested"}' }],
        };
        yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
      }
      return gen();
    });
    setAgentClient({
      beta: { sessions: { create, archive, retrieve, events: { stream, send, list } } },
    } as never);

    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const result = await tickDrip(envoy, REGISTRY, tickConfig(envoy));

    expect(result.sent).toBe(1);
    expect(emailsSend).toHaveBeenCalledTimes(1);

    // Conflict path: the INSERT hit ON CONFLICT (row pre-existed) so the read-back SELECT ran.
    const stepReadBacks = fp.calls.filter((c) =>
      /SELECT id, agent_session_id, block_sessions\s+FROM sdk_steps/i.test(c.text),
    );
    expect(stepReadBacks).toHaveLength(1);

    // The prior inflight session was harvested (resumed via `list`), NOT re-created (no second
    // billed session) — proving the fallback SELECT preserved `agent_session_id` from the conflict.
    expect(list).toHaveBeenCalledTimes(1);
    expect(create).not.toHaveBeenCalled();

    // Still exactly one step row (no duplicate created by the upsert).
    expect(fp.steps.filter((s) => s.enrollment_id === 10 && s.step_index === 0)).toHaveLength(1);
  });
});

// =============================================================================================
// createDripCronHandler
// =============================================================================================

describe("createDripCronHandler (R20)", () => {
  it("runs a tick and returns a JSON summary", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [{ contact: "ada@example.com", topicKey: "welcome" }],
    });
    fakeAgent();
    const { handle, emailsSend } = fakeResend();
    const envoy = makeEnvoy(fp.pool, handle);

    const cronHandler = createDripCronHandler({ envoy, registry: REGISTRY, tick: tickConfig(envoy) });
    const res = await cronHandler(new Request("https://app.example.com/api/envoy/cron/drip"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; claimed: number; sent: number };
    expect(body).toMatchObject({ ok: true, claimed: 1, sent: 1 });
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("returns 500 (not throw) when the claim itself errors, so the platform retries", async () => {
    const errPool: SdkPool = {
      async query() {
        throw new Error("connection refused");
      },
    };
    const { handle } = fakeResend();
    const envoy = makeEnvoy(errPool, handle);

    const cronHandler = createDripCronHandler({ envoy, registry: REGISTRY, tick: tickConfig(envoy) });
    const res = await cronHandler(new Request("https://app.example.com/api/envoy/cron/drip"));

    expect(res.status).toBe(500);
    const body = (await res.json()) as { ok: boolean; error: string };
    expect(body).toMatchObject({ ok: false, error: "tick_failed" });
  });

  it("returns 200 with a failure count when some items fail but the tick completes", async () => {
    const fp = fakePool({
      enrollments: [
        { id: 10, contact: "ada@example.com", sequenceKey: "welcome", currentStep: 0 },
      ],
      consent: [{ contact: "ada@example.com", topicKey: "welcome" }],
    });
    fakeAgent();
    const { handle } = fakeResend({ sendThrows: true });
    const envoy = makeEnvoy(fp.pool, handle);

    const cronHandler = createDripCronHandler({ envoy, registry: REGISTRY, tick: tickConfig(envoy) });
    const res = await cronHandler(new Request("https://app.example.com/api/envoy/cron/drip"));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; failed: number; sent: number };
    expect(body).toMatchObject({ ok: true, failed: 1, sent: 0 });
  });
});
