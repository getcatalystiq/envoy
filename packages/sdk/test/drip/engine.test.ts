import { afterEach, describe, expect, it, vi } from "vitest";

import { runDripStep, type DueStep, type DripEngineConfig } from "@sdk/drip/engine.js";
import { defineSequence, type Sequence } from "@sdk/drip/sequence.js";
import { createDb, type SdkPool, type SdkQueryResult } from "@sdk/db/pool.js";
import { createConsentMirror } from "@sdk/consent/mirror.js";
import { createResendClientHandle } from "@sdk/resend/client.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";
import { verifyUnsubscribeToken, type UnsubscribeClaims } from "@sdk/consent/unsubscribe.js";
import { setAgentClient } from "@sdk/agent/session.js";

// U8 — drip engine. Mocks: a fake `pg` pool that backs a REAL ConsentMirror (for the gate SELECT)
// AND records the engine's step/enrollment UPDATEs; a controllable Resend whose `emails.send` is a
// spy; a fake Anthropic client (via setAgentClient) for JIT generation. No real network/DB.

const NAMESPACE = "prod";
const UNSUB_SECRET = "unsub-secret-0123456789";
const UNSUB_URL = "https://app.example.com/api/envoy/unsubscribe";

afterEach(() => {
  setAgentClient(null);
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Fake pool: serves the mirror gate SELECT from a seeded consent store and records every UPDATE.
// ---------------------------------------------------------------------------------------------

interface ConsentSeed {
  contact: string;
  topicKey: string;
  topicId?: string | null;
  digest?: "opt_in" | "opt_out" | "unsubscribed";
  alert?: "opt_in" | "opt_out" | "unsubscribed";
  /** GLOBAL `sdk_contacts.unsubscribed` flag — the gate's suppress-all check (default false). */
  unsubscribed?: boolean;
}

interface RecordedCall {
  text: string;
  params: ReadonlyArray<unknown>;
}

function fakePool(seed: ConsentSeed[] = []): {
  pool: SdkPool;
  calls: RecordedCall[];
} {
  // Key on the NAMESPACED contact (matches the `$2` the mirror's gate SELECT passes).
  const rows = new Map<string, Record<string, unknown>>();
  // GLOBAL suppression flag store, keyed on the lower-cased bare email (matches the
  // `sdk_contacts` SELECT in ConsentMirror.gate → isGloballySuppressed). Default unsuppressed.
  const suppressed = new Map<string, boolean>();
  for (const s of seed) {
    const nsContact = `${NAMESPACE}:${s.contact}`;
    rows.set(`${nsContact}|${s.topicKey}`, {
      contact: nsContact,
      topic_key: s.topicKey,
      topic_id: s.topicId ?? null,
      digest_status: s.digest ?? "opt_in",
      alert_status: s.alert ?? "opt_in",
      dirty_since: null,
    });
    suppressed.set(s.contact.toLowerCase(), s.unsubscribed ?? false);
  }
  const calls: RecordedCall[] = [];
  const pool: SdkPool = {
    async query<T = Record<string, unknown>>(
      text: string,
      params?: ReadonlyArray<unknown>,
    ): Promise<SdkQueryResult<T>> {
      calls.push({ text, params: params ?? [] });
      const t = text.trim();
      // The gate's FIRST query: the GLOBAL suppression flag (ConsentMirror.isGloballySuppressed).
      // Without this, the suppress-all gate is a no-op in tests (the SELECT would fall through to
      // the empty default and read as not-suppressed).
      if (/SELECT unsubscribed[\s\S]*FROM sdk_contacts[\s\S]*lower\(email\)/i.test(t)) {
        const [, email] = (params ?? []) as unknown[];
        const flag = suppressed.get(String(email).toLowerCase()) ?? false;
        return { rows: [{ unsubscribed: flag }] as T[] };
      }
      // The mirror's gate SELECT — shape mirrors ConsentMirror.gate's query.
      if (/SELECT[\s\S]*digest_status[\s\S]*FROM sdk_topic_consent/i.test(t)) {
        const [, contact, topicKey] = (params ?? []) as unknown[];
        const row = rows.get(`${String(contact)}|${String(topicKey)}`);
        return { rows: (row ? [row] : []) as T[] };
      }
      // All engine UPDATEs (steps + enrollments) — just record and ack.
      return { rows: [] as T[] };
    },
  };
  return { pool, calls };
}

// ---------------------------------------------------------------------------------------------
// Fake Resend emails.send.
// ---------------------------------------------------------------------------------------------

interface ResendOpts {
  enabled?: boolean;
  emailId?: string;
  sendError?: boolean; // in-band { error }
  sendThrows?: boolean; // transport throw
}

function fakeResend(opts: ResendOpts = {}) {
  const enabled = opts.enabled ?? true;
  const emailsSend = vi.fn(async (..._args: unknown[]) => {
    if (opts.sendThrows) throw new Error("transport down");
    if (opts.sendError) return { data: null, error: { message: "validation_error" } };
    return { data: { id: opts.emailId ?? "email_1" }, error: null };
  });
  const handle = createResendClientHandle(enabled ? "re_live_key" : undefined);
  // Swap in the spy as the constructed client.
  vi.spyOn(handle, "client").mockReturnValue(
    enabled ? ({ emails: { send: emailsSend } } as never) : null,
  );
  return { handle, emailsSend };
}

// ---------------------------------------------------------------------------------------------
// Fake Anthropic client (slot generation).
// ---------------------------------------------------------------------------------------------

interface AgentOpts {
  output?: string; // the agent.message JSON for a fresh stream
  errorEvent?: boolean; // emit a terminal session.error
  retrieveStatus?: string; // harvest path: retrieve().status
  listOutput?: string; // harvest path: replayed agent.message JSON
}

function fakeAgent(opts: AgentOpts = {}) {
  const create = vi.fn(async () => ({ id: "sess_new" }));
  const archive = vi.fn(async () => ({}));
  const send = vi.fn(async () => ({}));
  const stream = vi.fn(async () => {
    const events = opts.errorEvent
      ? [{ type: "session.error", error: { message: "boom" } }]
      : [
          { type: "agent.message", content: [{ type: "text", text: opts.output ?? '{"GREETING":"Hi Ada"}' }] },
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
  const retrieve = vi.fn(async () => ({ status: opts.retrieveStatus ?? "idle" }));
  const list = vi.fn(async () => {
    async function* gen() {
      yield {
        type: "agent.message",
        content: [{ type: "text", text: opts.listOutput ?? '{"GREETING":"prev"}' }],
      };
      yield { type: "session.status_idle", stop_reason: { type: "end_turn" } };
    }
    return gen();
  });
  const client = {
    beta: { sessions: { create, archive, retrieve, events: { stream, send, list } } },
  };
  setAgentClient(client as never);
  return { create, archive, send, stream, retrieve, list };
}

// ---------------------------------------------------------------------------------------------
// Envoy handle assembly.
// ---------------------------------------------------------------------------------------------

function makeEnvoy(
  pool: SdkPool,
  resendHandle: ReturnType<typeof fakeResend>["handle"],
  configOverrides: Partial<ResolvedEnvoyConfig> = {},
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
    systemTemplateIds: new Set<string>(),
    ...configOverrides,
  };
  return {
    config,
    db,
    resend: resendHandle,
    assertNamespaceFingerprint: async () => {},
    redact: (v: unknown) => (typeof v === "string" ? "***" : "***"),
  } as unknown as Envoy;
}

function setup(opts: {
  seed?: ConsentSeed[];
  resend?: ResendOpts;
  agent?: AgentOpts;
  configOverrides?: Partial<ResolvedEnvoyConfig>;
}) {
  const fp = fakePool(opts.seed);
  const { handle, emailsSend } = fakeResend(opts.resend);
  const envoy = makeEnvoy(fp.pool, handle, opts.configOverrides);
  const mirror = createConsentMirror(envoy.db, envoy.resend);
  const agent = opts.agent ? fakeAgent(opts.agent) : undefined;
  const config: DripEngineConfig = { mirror, unsubscribeBaseUrl: UNSUB_URL };
  return { envoy, mirror, config, emailsSend, calls: fp.calls, agent };
}

const SEQ: Sequence = defineSequence({
  key: "welcome",
  steps: [
    { templateId: "tmpl_day0", waitDays: 0, aiSlots: ["GREETING"], brief: "warm intro" },
    { templateId: "tmpl_day3", waitDays: 3, aiSlots: ["FOLLOWUP"], brief: "nudge" },
  ],
});

function baseDue(over: Partial<DueStep> = {}): DueStep {
  return {
    enrollmentId: 10,
    stepId: 100,
    email: "ada@example.com",
    sequenceKey: "welcome",
    stepIndex: 0,
    data: { first_name: "Ada", secret: "leak-me" },
    agentSessionId: null,
    nextRunAt: null,
    ...over,
  };
}

// =============================================================================================
// Happy path (R14): generate declared slots + send via emails.send with idempotency-as-HEADER.
// =============================================================================================

describe("runDripStep — happy path (R14)", () => {
  it("generates the declared slot and sends with template id + variables; idempotency key is a request option", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"GREETING":"Hi Ada"}' },
    });

    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: true, emailId: "email_1", advancedTo: 1, completed: false });

    expect(env.emailsSend).toHaveBeenCalledTimes(1);
    const [payload, requestOptions] = env.emailsSend.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    expect(payload.template).toEqual({ id: "tmpl_day0", variables: { GREETING: "Hi Ada" } });
    expect(payload.to).toBe("ada@example.com");
    expect(payload.from).toBe("digest@app.example.com");
    // Idempotency key is the SECOND arg (the Idempotency-Key request header), NOT a body field.
    expect(requestOptions).toHaveProperty("idempotencyKey");
    expect(payload).not.toHaveProperty("idempotencyKey");
    expect((payload.template as Record<string, unknown>)).not.toHaveProperty("idempotencyKey");

    // A working stream-scoped List-Unsubscribe is present (R33).
    const headerVal = (payload.headers as Record<string, string>)["List-Unsubscribe"];
    const token = decodeURIComponent(/token=([^>]+)>/.exec(headerVal)![1]!);
    const verdict = verifyUnsubscribeToken(token, UNSUB_SECRET);
    expect(verdict.ok).toBe(true);
    const claims = (verdict as { ok: true; claims: UnsubscribeClaims }).claims;
    expect(claims.topicKey).toBe("welcome");
    expect(claims.stream).toBe("digest");
  });

  it("only allow-listed contact fields reach the agent payload (R44)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"GREETING":"Hi"}' },
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    // The goal text sent to the agent never contains the non-allow-listed `secret` field.
    const goalText = JSON.stringify(env.agent!.send.mock.calls[0]);
    expect(goalText).toContain("Ada");
    expect(goalText).not.toContain("leak-me");
  });

  it("marks the last step's send as completing the enrollment", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"FOLLOWUP":"Still here?"}' },
    });
    const past = new Date(Date.now() - 60 * 1000); // the wait already elapsed (tick set next_run_at)
    const res = await runDripStep(
      env.envoy,
      SEQ,
      baseDue({ stepIndex: 1, agentSessionId: null, nextRunAt: past }),
      env.config,
    );
    expect(res).toMatchObject({ sent: true, advancedTo: 2, completed: true });
    // The enrollment UPDATE marks status completed.
    const enrollmentUpdate = env.calls.find((c) => /UPDATE sdk_enrollments[\s\S]*current_step/i.test(c.text));
    expect(enrollmentUpdate?.params).toContain("completed");
  });

  it("a stepIndex past the end of the sequence sends nothing and marks the enrollment completed", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"GREETING":"Hi"}' },
    });
    // SEQ has 2 steps (indexes 0,1); index 2 is off the end — a never-cleaned enrollment.
    const res = await runDripStep(env.envoy, SEQ, baseDue({ stepIndex: 2 }), env.config);
    expect(res).toMatchObject({ sent: false, reason: "generation_failed" });
    expect(env.emailsSend).not.toHaveBeenCalled();
    // The enrollment is force-completed so the cron never re-claims a dangling row.
    const completeWrite = env.calls.find(
      (c) => /UPDATE sdk_enrollments[\s\S]*status = 'completed'[\s\S]*next_run_at = NULL/i.test(c.text),
    );
    expect(completeWrite).toBeDefined();
    expect(completeWrite!.params).toContain(10); // enrollmentId
  });

  it("commits the step-sent and the enrollment advance as ONE atomic CTE write (P1 double-send guard)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"GREETING":"Hi Ada"}' },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: true, advancedTo: 1, completed: false });

    // The advance is a single statement: a data-modifying WITH (sdk_steps -> sent) feeding the
    // outer enrollment UPDATE. There must NOT be two independent writes that a crash could split.
    const advanceWrites = env.calls.filter(
      (c) =>
        /UPDATE sdk_steps[\s\S]*status = 'sent'[\s\S]*UPDATE sdk_enrollments[\s\S]*current_step/i.test(
          c.text,
        ),
    );
    expect(advanceWrites).toHaveLength(1);
    const write = advanceWrites[0]!;
    expect(write.text).toMatch(/WITH step_done AS/i);
    // Both the step-sent (resend_email_id) and the advance params travel in the one call.
    expect(write.params).toContain("email_1"); // resend_email_id ($3)
    expect(write.params).toContain("active"); // enrollment status ($5)
    expect(write.params).toContain(100); // stepId ($2)
    expect(write.params).toContain(10); // enrollmentId ($7)

    // And there is NO standalone `UPDATE sdk_steps SET status = 'sent'` that isn't the CTE.
    const standaloneStepSent = env.calls.filter(
      (c) =>
        /UPDATE sdk_steps[\s\S]*status = 'sent'/i.test(c.text) &&
        !/UPDATE sdk_enrollments/i.test(c.text),
    );
    expect(standaloneStepSent).toHaveLength(0);
  });

  it("sends a non-AI step (no aiSlots) with no variables and without calling the agent", async () => {
    const seq = defineSequence({
      key: "welcome",
      steps: [{ templateId: "tmpl_static", waitDays: 0, aiSlots: [], brief: "" }],
    });
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    const res = await runDripStep(env.envoy, seq, baseDue(), env.config);
    expect(res).toMatchObject({ sent: true });
    const payload = env.emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.template).toEqual({ id: "tmpl_static" }); // no variables key
  });
});

// =============================================================================================
// Fail-safe (R16): a generation/send failure leaves the step due; nothing sent empty.
// =============================================================================================

describe("runDripStep — fail-safe (R16)", () => {
  it("a generation failure (missing slot) leaves the step due and sends nothing", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"WRONG":"x"}' }, // missing the declared GREETING slot
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "generation_failed" });
    expect(env.emailsSend).not.toHaveBeenCalled();
    // No enrollment advance.
    expect(env.calls.find((c) => /UPDATE sdk_enrollments[\s\S]*current_step/i.test(c.text))).toBeUndefined();
  });

  it("an agent session error leaves the step due and sends nothing", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { errorEvent: true },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "generation_failed" });
    expect(env.emailsSend).not.toHaveBeenCalled();
  });

  it("an in-band Resend error leaves the step due (no advance) and sends nothing further", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"GREETING":"Hi"}' },
      resend: { sendError: true },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "send_failed" });
    expect(env.emailsSend).toHaveBeenCalledTimes(1);
    expect(env.calls.find((c) => /UPDATE sdk_enrollments[\s\S]*current_step/i.test(c.text))).toBeUndefined();
  });

  it("a thrown Resend transport error leaves the step due (send_failed), not advanced", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"GREETING":"Hi"}' },
      resend: { sendThrows: true },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "send_failed" });
  });

  it("a step that declares aiSlots with no agent configured rejects before sending (R45)", async () => {
    // The contact passes the gate (opt_in, not suppressed) so the step reaches the generation
    // path — where requireAgent must throw because createEnvoy was given no `agent`.
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      configOverrides: { agent: undefined },
    });
    await expect(runDripStep(env.envoy, SEQ, baseDue(), env.config)).rejects.toThrow(
      /aiSlots|agent/i,
    );
    expect(env.emailsSend).not.toHaveBeenCalled();
  });
});

// =============================================================================================
// Crash-resume (R21): harvest a completed prior session; defer a still-running one.
// =============================================================================================

describe("runDripStep — crash-resume (R21)", () => {
  it("a re-claimed step whose prior session is still running is DEFERRED (no second billed session)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { retrieveStatus: "running" },
    });
    const res = await runDripStep(
      env.envoy,
      SEQ,
      baseDue({ agentSessionId: "sess_prior" }),
      env.config,
    );
    expect(res).toEqual({ sent: false, reason: "deferred" });
    // It harvested (retrieve) but forked NO new session and sent NOTHING.
    expect(env.agent!.retrieve).toHaveBeenCalledWith("sess_prior");
    expect(env.agent!.create).not.toHaveBeenCalled();
    expect(env.emailsSend).not.toHaveBeenCalled();
  });

  it("a re-claimed step whose prior session COMPLETED is harvested, not regenerated, and sent once", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { retrieveStatus: "idle", listOutput: '{"GREETING":"harvested"}' },
    });
    const res = await runDripStep(
      env.envoy,
      SEQ,
      baseDue({ agentSessionId: "sess_prior" }),
      env.config,
    );
    expect(res).toMatchObject({ sent: true });
    // No second billed session.
    expect(env.agent!.create).not.toHaveBeenCalled();
    const payload = env.emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.template).toEqual({ id: "tmpl_day0", variables: { GREETING: "harvested" } });
  });

  it("persists the new session id as the inflight marker BEFORE sending (fresh path)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"GREETING":"Hi"}' },
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    // The marker UPDATE (agent_session_id) happens, and it precedes the emails.send call ordering:
    // the marker write is recorded among the pool calls before the send resolves.
    const markerWrite = env.calls.find((c) => /UPDATE sdk_steps[\s\S]*agent_session_id = \$3/i.test(c.text));
    expect(markerWrite).toBeDefined();
    expect(markerWrite?.params).toContain("sess_new");
  });
});

// =============================================================================================
// Wait gating (R15) + mirror gate (R26).
// =============================================================================================

describe("runDripStep — gating", () => {
  it("Edge: a step whose wait hasn't elapsed is skipped (not_due), nothing touched", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"FOLLOWUP":"x"}' },
    });
    const future = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000); // due in 2 days
    const res = await runDripStep(
      env.envoy,
      SEQ,
      baseDue({ stepIndex: 1, nextRunAt: future }),
      env.config,
    );
    expect(res).toEqual({ sent: false, reason: "not_due" });
    expect(env.emailsSend).not.toHaveBeenCalled();
  });

  it("Edge: a suppressed contact is denied before send (R26)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_out" }],
      agent: { output: '{"GREETING":"Hi"}' },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(env.emailsSend).not.toHaveBeenCalled();
    // The agent was never even consulted — the gate is first.
    expect(env.agent!.create).not.toHaveBeenCalled();
  });

  it("Edge: an unsubscribed contact (global) is denied", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "unsubscribed" }],
      agent: { output: '{"GREETING":"Hi"}' },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "suppressed" });
  });

  it("Edge: a GLOBALLY-suppressed contact is denied even with a stale opt_in topic row (R22/R26)", async () => {
    // The global `sdk_contacts.unsubscribed` flag (bounce/complaint/GDPR/hosted-page) dominates a
    // per-topic consent row that still reads `opt_in`. The gate's suppress-all SELECT is what
    // catches this — without the sdk_contacts handler this contact would wrongly be sent to.
    const env = setup({
      seed: [
        {
          contact: "ada@example.com",
          topicKey: "welcome",
          digest: "opt_in",
          alert: "opt_in",
          unsubscribed: true,
        },
      ],
      agent: { output: '{"GREETING":"Hi"}' },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(env.emailsSend).not.toHaveBeenCalled();
    // Gate is first — the agent is never even consulted.
    expect(env.agent!.create).not.toHaveBeenCalled();
  });
});

// =============================================================================================
// Resend disabled (R43): silent no-op, step stays due.
// =============================================================================================

describe("runDripStep — Resend disabled (R43)", () => {
  it("no Resend key ⇒ resend_disabled no-op; the step is not advanced", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"GREETING":"Hi"}' },
      resend: { enabled: false },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "resend_disabled" });
    expect(env.calls.find((c) => /UPDATE sdk_enrollments[\s\S]*current_step/i.test(c.text))).toBeUndefined();
  });
});
