import { afterEach, describe, expect, it, vi } from "vitest";

import {
  runDripStep,
  dripBackoffMs,
  RESEND_TEMPLATE_VARIABLE_MAX,
  DEFAULT_DRIP_MAX_ATTEMPTS,
  MAX_DRIP_MAX_ATTEMPTS,
  DRIP_OPTED_OUT_RECHECK_MS,
  DRIP_BACKOFF_BASE_MS,
  DRIP_BACKOFF_MAX_MS,
  type DueStep,
  type DripEngineConfig,
} from "@sdk/drip/engine.js";
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

function fakePool(
  seed: ConsentSeed[] = [],
  opts: { priorAttempts?: number } = {},
): {
  pool: SdkPool;
  calls: RecordedCall[];
} {
  // The step's recorded failures so far (`sdk_steps.attempts`), bumped by the failure CTE.
  let attempts = opts.priorAttempts ?? 0;
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
      // The failure CTE (recordFailure): bump attempts; at the cap ($4) the enrollment is stopped.
      if (/step_fail AS \(/i.test(t)) {
        const max = Number((params ?? [])[3]);
        const transient = (params ?? [])[7] === true;
        attempts += 1;
        return {
          rows: [{ permanent_failures: attempts, status: attempts >= max && !transient ? "stopped" : "active" }] as T[],
        };
      }
      // Closing a permanently suppressed enrollment, holding an opted-out one, or the advance after
      // a send: one row moved (RETURNING id), unless the test says another attempt got there first.
      if (/(status = 'suppressed'|\$4::bigint \* INTERVAL)[\s\S]*RETURNING id/i.test(t)) {
        return { rows: [{ id: (params ?? [])[1] }] as T[] };
      }
      // All other engine UPDATEs (steps + enrollments) — just record and ack.
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
  sendError?: boolean; // in-band { error } (a 422 unless `sendStatus` says otherwise)
  sendStatus?: number | null;
  sendThrows?: boolean; // transport throw
}

function fakeResend(opts: ResendOpts = {}) {
  const enabled = opts.enabled ?? true;
  const emailsSend = vi.fn(async (..._args: unknown[]) => {
    if (opts.sendThrows) throw new Error("transport down");
    if (opts.sendError) {
      return {
        data: null,
        error: { message: "validation_error", statusCode: opts.sendStatus === undefined ? 422 : opts.sendStatus },
      };
    }
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
          { type: "agent.message", content: [{ type: "text", text: opts.output ?? '{"body":"Hi Ada"}' }] },
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
        content: [{ type: "text", text: opts.listOutput ?? '{"body":"prev"}' }],
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
  priorAttempts?: number;
  resend?: ResendOpts;
  agent?: AgentOpts;
  configOverrides?: Partial<ResolvedEnvoyConfig>;
}) {
  const fp = fakePool(opts.seed, { priorAttempts: opts.priorAttempts });
  const { handle, emailsSend } = fakeResend(opts.resend);
  const envoy = makeEnvoy(fp.pool, handle, opts.configOverrides);
  const mirror = createConsentMirror(envoy.db, envoy.resend);
  const agent = opts.agent ? fakeAgent(opts.agent) : undefined;
  const config: DripEngineConfig = { mirror, unsubscribeBaseUrl: UNSUB_URL };
  return { envoy, mirror, config, emailsSend, calls: fp.calls, agent };
}

const SEQ: Sequence = defineSequence({
  key: "welcome",
  // Agent is resolved PER-SEQUENCE now (not from a global config) — the sequence carries it.
  agent: { agentId: "agent_1", environmentId: "env_1" },
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
    blockSessions: {},
    nextRunAt: null,
    enrolledAt: null,
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
      agent: { output: '{"body":"Hi Ada"}' },
    });

    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: true, emailId: "email_1", advancedTo: 1, completed: false });

    expect(env.emailsSend).toHaveBeenCalledTimes(1);
    const [payload, requestOptions] = env.emailsSend.mock.calls[0]! as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const tmpl = payload.template as { id: string; variables: Record<string, string> };
    expect(tmpl.id).toBe("tmpl_day0");
    expect(tmpl.variables.GREETING).toBe("Hi Ada");
    // The in-body unsubscribe link is injected as UNSUBSCRIBE_URL, matching the header URL (R33).
    expect(tmpl.variables.UNSUBSCRIBE_URL).toMatch(/^https:\/\/.+token=/);
    expect((payload.headers as Record<string, string>)["List-Unsubscribe"]).toBe(`<${tmpl.variables.UNSUBSCRIBE_URL}>`);
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
      agent: { output: '{"body":"Hi"}' },
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
      agent: { output: '{"body":"Still here?"}' },
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
      agent: { output: '{"body":"Hi"}' },
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
      agent: { output: '{"body":"Hi Ada"}' },
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
    {
      const tmpl = payload.template as { id: string; variables: Record<string, string> };
      expect(tmpl.id).toBe("tmpl_static");
      // No AI slots, but the drip lane always injects the in-body unsubscribe link.
      expect(Object.keys(tmpl.variables)).toEqual(["UNSUBSCRIBE_URL"]);
    }
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
      agent: { output: '{"body":"Hi"}' },
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
      agent: { output: '{"body":"Hi"}' },
      resend: { sendThrows: true },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "send_failed" });
  });

  it("a step that declares aiSlots on a sequence with no per-sequence agent rejects before sending (R45/R9)", async () => {
    // The contact passes the gate (opt_in, not suppressed) so the step reaches the generation path —
    // where requireAgent(sequence) must throw because THE SEQUENCE has no agent (no global fallback).
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    const noAgentSeq = defineSequence({
      key: "welcome",
      steps: [{ templateId: "tmpl_day0", waitDays: 0, aiSlots: ["GREETING"], brief: "warm intro" }],
    });
    await expect(runDripStep(env.envoy, noAgentSeq, baseDue(), env.config)).rejects.toThrow(
      /aiSlots|agent/i,
    );
    expect(env.emailsSend).not.toHaveBeenCalled();
  });

  it("passes vault_ids to session-create only when the sequence agent carries a vaultId", async () => {
    const withVault = defineSequence({
      key: "welcome",
      agent: { agentId: "agent_1", environmentId: "env_1", vaultId: "vlt_abc" },
      steps: [{ templateId: "tmpl_day0", waitDays: 0, aiSlots: ["GREETING"], brief: "warm intro" }],
    });
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"body":"Hi"}' },
    });
    await runDripStep(env.envoy, withVault, baseDue(), env.config);
    // the fake's sessions.create spy records its payload — assert vault_ids carried through
    expect(env.agent?.create).toHaveBeenCalledWith(expect.objectContaining({ vault_ids: ["vlt_abc"] }));
  });

  it("omits vault_ids when the sequence agent has no vaultId", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"body":"Hi"}' },
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config); // SEQ agent has no vaultId
    const calls = env.agent?.create.mock.calls as ReadonlyArray<ReadonlyArray<unknown>> | undefined;
    const createArg = calls?.[0]?.[0] as Record<string, unknown> | undefined;
    expect(createArg && "vault_ids" in createArg).toBe(false);
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
      baseDue({ blockSessions: { GREETING: "sess_prior" } }),
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
      agent: { retrieveStatus: "idle", listOutput: '{"body":"harvested"}' },
    });
    const res = await runDripStep(
      env.envoy,
      SEQ,
      baseDue({ blockSessions: { GREETING: "sess_prior" } }),
      env.config,
    );
    expect(res).toMatchObject({ sent: true });
    // No second billed session.
    expect(env.agent!.create).not.toHaveBeenCalled();
    const payload = env.emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    {
      const tmpl = payload.template as { id: string; variables: Record<string, string> };
      expect(tmpl.id).toBe("tmpl_day0");
      expect(tmpl.variables.GREETING).toBe("harvested");
      expect(tmpl.variables.UNSUBSCRIBE_URL).toMatch(/token=/);
    }
  });

  it("persists the new session id as the inflight marker BEFORE sending (fresh path)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"body":"Hi"}' },
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    // The per-slot marker UPDATE (block_sessions merge) happens, and it precedes the emails.send call:
    // the marker write is recorded among the pool calls before the send resolves.
    const markerWrite = env.calls.find((c) => /UPDATE sdk_steps[\s\S]*block_sessions = block_sessions/i.test(c.text));
    expect(markerWrite).toBeDefined();
    // params: [namespace, stepId, slotName, sessionId] — the new session id + the slot it belongs to.
    expect(markerWrite?.params).toContain("sess_new");
    expect(markerWrite?.params).toContain("GREETING");
  });
});

// =============================================================================================
// Wait gating (R15) + mirror gate (R26).
// =============================================================================================

describe("runDripStep — gating", () => {
  it("Edge: a step whose wait hasn't elapsed is skipped (not_due), nothing touched", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"body":"x"}' },
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

  it("Edge: a step-0 wait anchors to enrolled_at when next_run_at is NULL (hours/days first step)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"body":"x"}' },
    });
    // Override step 0 to a 1-hour wait (waitDays = 1/24); enroll() leaves next_run_at NULL.
    const seq = { ...SEQ, steps: [{ ...SEQ.steps[0], waitDays: 1 / 24 }, ...SEQ.steps.slice(1)] };
    const now = new Date("2026-01-01T12:00:00Z");

    // Enrolled 2h ago → the 1h wait has elapsed → eligible (no longer deadlocked as not_due).
    const elapsed = baseDue({ stepIndex: 0, nextRunAt: null, enrolledAt: new Date(now.getTime() - 2 * 3600_000) });
    const r1 = await runDripStep(env.envoy, seq, elapsed, env.config, now);
    expect(r1).not.toMatchObject({ reason: "not_due" });

    // Enrolled 10m ago → the 1h wait has NOT elapsed → still not_due.
    const pending = baseDue({ stepIndex: 0, nextRunAt: null, enrolledAt: new Date(now.getTime() - 10 * 60_000) });
    const r2 = await runDripStep(env.envoy, seq, pending, env.config, now);
    expect(r2).toEqual({ sent: false, reason: "not_due" });
  });

  it("Edge: a suppressed contact is denied before send (R26)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_out" }],
      agent: { output: '{"body":"Hi"}' },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "suppressed" });
    expect(env.emailsSend).not.toHaveBeenCalled();
    // The agent was never even consulted — the gate is first.
    expect(env.agent!.create).not.toHaveBeenCalled();
  });

  it("Edge: an unsubscribed contact (global) is denied, and its enrollment is closed", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "unsubscribed" }],
      agent: { output: '{"body":"Hi"}' },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "suppressed", detail: "enrollment closed" });
    const close = env.calls.find((c) => /status = 'suppressed'/i.test(c.text));
    expect(close).toBeDefined();
    expect(close!.text).toMatch(/AND status = 'active'/);
    expect(close!.params).toEqual(["prod", 10, 0]);
    expect(close!.text).toMatch(/AND current_step = \$3::int/);
  });

  it("Edge: an opt_out (not permanent) is NOT closed, but held a day before its next check", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_out" }],
      agent: { output: '{"body":"Hi"}' },
    });
    const now = new Date("2026-11-09T12:00:00.000Z");
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config, now);
    expect(res).toEqual({ sent: false, reason: "suppressed", detail: "opted out: next check in a day" });
    expect(env.calls.find((c) => /status = 'suppressed'/i.test(c.text))).toBeUndefined();
    const hold = env.calls.find((c) => /SET next_run_at = GREATEST\(\$3::timestamptz, NOW\(\)\) \+ \$4::bigint/.test(c.text));
    expect(hold?.params).toEqual(["prod", 10, now.toISOString(), DRIP_OPTED_OUT_RECHECK_MS, 0]);
    expect(hold!.text).toMatch(/AND status = 'active' AND current_step = \$5::int/);
  });

  it("Edge: no consent row yet (an enroll that raced the mirror) is denied but NOT closed or held", async () => {
    const env = setup({ seed: [], agent: { output: '{"body":"Hi"}' } });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(env.calls.find((c) => /UPDATE sdk_enrollments/i.test(c.text))).toBeUndefined();
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
      agent: { output: '{"body":"Hi"}' },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "suppressed", detail: "enrollment closed" });
    expect(env.emailsSend).not.toHaveBeenCalled();
    // Gate is first — the agent is never even consulted.
    expect(env.agent!.create).not.toHaveBeenCalled();
    expect(env.calls.find((c) => /status = 'suppressed'/i.test(c.text))).toBeDefined();
  });
});

// =============================================================================================
// AI block length (Resend refuses a template variable over 2,000 characters) + backoff + the cap.
// =============================================================================================

const LONG = "x".repeat(RESEND_TEMPLATE_VARIABLE_MAX + 1);
const AT_LIMIT = "y".repeat(RESEND_TEMPLATE_VARIABLE_MAX);
const body = (text: string) => JSON.stringify({ body: text });
const failureWrite = (calls: RecordedCall[]) => calls.filter((c) => /step_fail AS \(/i.test(c.text));
const discards = (calls: RecordedCall[]) =>
  calls.filter((c) => /block_sessions = block_sessions - \$3::text/i.test(c.text));

describe("runDripStep — AI block over Resend's per-value limit", () => {
  it("a value of exactly the limit is sent as is (nothing regenerated)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body(AT_LIMIT) },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: true });
    expect(env.agent!.create).toHaveBeenCalledTimes(1);
    expect(discards(env.calls)).toHaveLength(0);
  });

  it("an over-long HARVESTED block is discarded and regenerated once, fresh, then sent", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { retrieveStatus: "idle", listOutput: body(LONG), output: body("Short and sweet") },
    });
    const res = await runDripStep(
      env.envoy,
      SEQ,
      baseDue({ blockSessions: { GREETING: "sess_old" } }),
      env.config,
    );
    expect(res).toMatchObject({ sent: true });
    // The stored session was harvested first, then ONE fresh session was made.
    expect(env.agent!.list).toHaveBeenCalledTimes(1);
    expect(env.agent!.create).toHaveBeenCalledTimes(1);
    // The regeneration's own marker replaces the slot's (no separate discard on success).
    expect(discards(env.calls)).toHaveLength(0);
    const markers = env.calls.filter((c) => /block_sessions = block_sessions \|\|/i.test(c.text));
    expect(markers.map((c) => c.params[2])).toEqual(["GREETING"]);
    const [payload] = env.emailsSend.mock.calls[0]! as unknown as [{ template: { variables: Record<string, string> } }];
    expect(payload.template.variables.GREETING).toBe("Short and sweet");
    expect(failureWrite(env.calls)).toHaveLength(0);
  });

  it("still over-long after the one regeneration: nothing is sent, the failure is recorded and backed off", async () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body(LONG) },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config, now);
    expect(res).toMatchObject({ sent: false, reason: "generation_failed" });
    expect((res as { detail?: string }).detail).toMatch(/GREETING is 2001 characters, over Resend's 2000-character limit/);
    expect(env.emailsSend).not.toHaveBeenCalled();
    // Generated twice (the first + the ONE regeneration), never a third time in the same run.
    expect(env.agent!.create).toHaveBeenCalledTimes(2);
    // The regeneration's brief says why, with the length it must stay under (markup included).
    const goals = env.agent!.send.mock.calls.map((c) => JSON.stringify(c));
    expect(goals[0]).not.toContain("LENGTH LIMIT");
    expect(goals[1]).toContain("LENGTH LIMIT");
    expect(goals[1]).toContain("2001 characters");
    // The regenerated session's marker is KEPT: the next attempt harvests it free (one billed session).
    expect(discards(env.calls)).toHaveLength(0);
    const writes = failureWrite(env.calls);
    expect(writes).toHaveLength(1);
    // [namespace, stepId, reason, maxAttempts, enrollmentId, now, delays, transient, stepIndex]
    expect(writes[0]!.params).toEqual([
      "prod",
      100,
      expect.stringContaining("over Resend's 2000-character limit"),
      DEFAULT_DRIP_MAX_ATTEMPTS,
      10,
      now.toISOString(),
      expect.any(Array),
      false,
      0,
    ]);
    // The delays the SQL indexes ARE dripBackoffMs's (one formula, in TypeScript), up to the first
    // that reaches the maximum (every later failure waits that), whatever maxAttempts is.
    expect(writes[0]!.params[6]).toEqual([
      DRIP_BACKOFF_BASE_MS, 2 * DRIP_BACKOFF_BASE_MS, 4 * DRIP_BACKOFF_BASE_MS, 8 * DRIP_BACKOFF_BASE_MS,
      16 * DRIP_BACKOFF_BASE_MS, 32 * DRIP_BACKOFF_BASE_MS, DRIP_BACKOFF_MAX_MS,
    ]);
    expect(writes[0]!.text).toMatch(/LEAST\(f\.failed_attempts, cardinality\(\$7::bigint\[\]\)\)/);
    // Counted in the 005 counters, anchored to the later of the tick's clock and the database's.
    expect(writes[0]!.text).toMatch(/failed_attempts = failed_attempts \+ 1/);
    expect(writes[0]!.text).toMatch(/permanent_failures = permanent_failures \+ CASE/);
    expect(writes[0]!.text).toMatch(/GREATEST\(\$6::timestamptz, NOW\(\)\)/);
    // The failure moves only an ACTIVE enrollment (an unenroll is never overwritten), and the stop
    // is decided once, in the step update, which the enrollment update reads.
    // The enrollment is locked FIRST (the order advance and erasure take), then the step.
    expect(writes[0]!.text).toMatch(/WITH enr AS \([\s\S]*status = 'active'[\s\S]*FOR NO KEY UPDATE/);
    expect(writes[0]!.text).toMatch(/EXISTS \(SELECT 1 FROM enr\)/);
    expect(writes[0]!.text).toMatch(/WHERE e\.namespace = \$1 AND e\.id = \$5 AND e\.status = 'active'/);
    expect(writes[0]!.text).toMatch(/AS stop/);
  });

  it("the next attempt harvests the kept over-long block and regenerates ONCE, with the note", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { retrieveStatus: "idle", listOutput: body(LONG), output: body("Short") },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue({ blockSessions: { GREETING: "sess_long" } }), env.config);
    expect(res).toMatchObject({ sent: true });
    expect(env.agent!.create).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(env.agent!.send.mock.calls[0])).toContain("LENGTH LIMIT");
  });

  it("a regeneration that fails is a recorded generation failure; the long block is never sent", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { retrieveStatus: "idle", listOutput: body(LONG), errorEvent: true },
    });
    const res = await runDripStep(
      env.envoy,
      SEQ,
      baseDue({ blockSessions: { GREETING: "sess_old" } }),
      env.config,
    );
    // The fresh regeneration errored → a recorded generation failure, never a send of the long one.
    expect(res).toMatchObject({ sent: false, reason: "generation_failed" });
    expect(env.emailsSend).not.toHaveBeenCalled();
    expect(failureWrite(env.calls)).toHaveLength(1);
  });
});

describe("runDripStep — backoff and the attempt cap", () => {
  it("dripBackoffMs doubles from 15 minutes and stops at 12 hours", () => {
    expect(dripBackoffMs(1)).toBe(15 * 60 * 1000);
    expect(dripBackoffMs(2)).toBe(30 * 60 * 1000);
    expect(dripBackoffMs(3)).toBe(60 * 60 * 1000);
    expect(dripBackoffMs(6)).toBe(8 * 60 * 60 * 1000);
    expect(dripBackoffMs(7)).toBe(DRIP_BACKOFF_MAX_MS);
    // Under Resend's 24-hour idempotency-key lifetime, so a lost-answer retry meets the 409.
    expect(DRIP_BACKOFF_MAX_MS).toBe(12 * 60 * 60 * 1000);
    expect(dripBackoffMs(100)).toBe(DRIP_BACKOFF_MAX_MS);
    expect(dripBackoffMs(0)).toBe(DRIP_BACKOFF_BASE_MS);
  });

  it("a Resend 409 invalid_idempotent_request is NOT proof the email went out: transient, retried", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
    });
    env.emailsSend.mockResolvedValueOnce({
      data: null,
      error: { message: "used", statusCode: 409, name: "invalid_idempotent_request" },
    } as never);
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "send_failed" });
    expect(env.calls.find((c) => /current_step = \$8::int/.test(c.text))).toBeUndefined();
    expect(failureWrite(env.calls)[0]!.params[7]).toBe(true);
  });

  it("a Resend 409 concurrent_idempotent_requests is transient (backed off, never counted)", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
    });
    env.emailsSend.mockResolvedValueOnce({
      data: null,
      error: { message: "busy", statusCode: 409, name: "concurrent_idempotent_requests" },
    } as never);
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "send_failed" });
    expect(failureWrite(env.calls)[0]!.params[7]).toBe(true);
  });

  it("a failure that cannot be recorded is logged with its SQLSTATE only, and reads as not stopped", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    const query = env.envoy.db.execWrite.bind(env.envoy.db);
    vi.spyOn(env.envoy.db, "execWrite").mockImplementation(async (text, params) => {
      if (/step_fail AS \(/.test(text)) {
        throw Object.assign(new Error('column "failed_attempts" does not exist ada@example.com'), { code: "42703" });
      }
      return query(text, params);
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "send_failed" });
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![1]).toBe("42703");
    expect(String(error.mock.calls[0]![0])).toContain("migration 005");
    expect(JSON.stringify(error.mock.calls)).not.toContain("ada@example.com");
  });

  it("any other error recording a failure (a deadlock) also falls back to the hour's wait, without the migration hint", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    const query = env.envoy.db.execWrite.bind(env.envoy.db);
    vi.spyOn(env.envoy.db, "execWrite").mockImplementation(async (text, params) => {
      if (/step_fail AS \(/.test(text) && /failed_attempts/.test(text)) {
        throw Object.assign(new Error("deadlock"), { code: "40P01" }); // the retry deadlocks too
      }
      return query(text, params);
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(error).toHaveBeenCalledTimes(1);
    expect(error.mock.calls[0]![1]).toBe("40P01");
    expect(String(error.mock.calls[0]![0])).not.toContain("migration");
    expect(env.calls.find((c) => /INTERVAL '1 hour'/.test(c.text))).toBeDefined();
  });

  it("the advance after a send always moves current_step, but status and next run only of an ACTIVE enrollment", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    const adv = env.calls.find((c) => /UPDATE sdk_enrollments[\s\S]*current_step = \$4/i.test(c.text));
    expect(adv!.text).toMatch(/status = CASE WHEN status = 'active' THEN \$5 ELSE status END/);
    // Pinned on the step it sent, so a stale overlapping attempt never moves the enrollment back.
    expect(adv!.text).toMatch(/AND current_step = \$8::int/);
    expect(adv!.params[7]).toBe(0);
    expect(adv!.text).toMatch(/next_run_at = CASE WHEN status = 'active' THEN \$6::timestamptz ELSE next_run_at END/);
  });

  it("the advance leaves a step another attempt already recorded sent alone", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    const adv = env.calls.find((c) => /current_step = \$8::int/.test(c.text));
    expect(adv!.text).toMatch(/AND status <> 'sent'/);
  });

  it("a deadlock recording a failure is retried once, so the failure is still counted", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    const query = env.envoy.db.execWrite.bind(env.envoy.db);
    let thrown = 0;
    vi.spyOn(env.envoy.db, "execWrite").mockImplementation(async (text, params) => {
      if (/failed_attempts/.test(text) && thrown === 0) {
        thrown += 1;
        throw Object.assign(new Error("deadlock"), { code: "40P01" });
      }
      return query(text, params);
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(failureWrite(env.calls)).toHaveLength(1); // the retry landed (the fake records it)
    expect(env.calls.find((c) => /INTERVAL '1 hour'/.test(c.text))).toBeUndefined();
  });

  it.each(["08006", "57P01", "EPIPE"])("a recording error %s (outcome unknown) writes nothing more", async (code) => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    const query = env.envoy.db.execWrite.bind(env.envoy.db);
    vi.spyOn(env.envoy.db, "execWrite").mockImplementation(async (text, params) => {
      if (/failed_attempts/.test(text)) throw Object.assign(new Error("x"), { code });
      return query(text, params);
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(env.calls.find((c) => /INTERVAL '1 hour'/.test(c.text))).toBeUndefined();
  });

  it("an old enrollment with no consent row is held a day; a fresh one (an enroll racing the mirror) is not", async () => {
    const now = new Date("2026-11-09T12:00:00.000Z");
    const old = setup({ seed: [], agent: { output: body("Hi") } });
    const res = await runDripStep(old.envoy, SEQ, baseDue({ enrolledAt: new Date(now.getTime() - 2 * 86_400_000) }), old.config, now);
    expect(res).toEqual({ sent: false, reason: "suppressed", detail: "no consent: next check in a day" });
    const fresh = setup({ seed: [], agent: { output: body("Hi") } });
    const res2 = await runDripStep(fresh.envoy, SEQ, baseDue({ enrolledAt: new Date(now.getTime() - 60_000) }), fresh.config, now);
    expect(res2).toEqual({ sent: false, reason: "suppressed" });
    expect(fresh.calls.find((c) => /UPDATE sdk_enrollments/i.test(c.text))).toBeUndefined();
  });

  it("an AI step with no agent fails loud even with no Resend key", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      resend: { enabled: false },
    });
    const noAgentSeq = defineSequence({
      key: "welcome",
      steps: [{ templateId: "tmpl_day0", waitDays: 0, aiSlots: ["GREETING"], brief: "x" }],
    });
    await expect(runDripStep(env.envoy, noAgentSeq, baseDue(), env.config)).rejects.toThrow(/no per-sequence `agent`/);
  });

  it("a failure whose statement lost its answer (no SQLSTATE) writes nothing more: it may have committed", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    const query = env.envoy.db.execWrite.bind(env.envoy.db);
    vi.spyOn(env.envoy.db, "execWrite").mockImplementation(async (text, params) => {
      if (/failed_attempts/.test(text)) throw new Error("Connection terminated unexpectedly");
      return query(text, params);
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(env.calls.find((c) => /INTERVAL '1 hour'/.test(c.text))).toBeUndefined();
  });

  it("a send failure is recorded through the backoff write (transient), not retried next tick", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "send_failed" });
    expect(failureWrite(env.calls)).toHaveLength(1);
    // Even a 422: no Resend refusal is a verdict on the block (its length is checked before).
    expect(failureWrite(env.calls)[0]!.params[7]).toBe(true);
  });

  it("an agent CALL failure (session error) is transient; unusable OUTPUT is permanent", async () => {
    const call = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { errorEvent: true },
    });
    await runDripStep(call.envoy, SEQ, baseDue(), call.config);
    expect(failureWrite(call.calls)[0]!.params[7]).toBe(true);
    setAgentClient(null);
    const output = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"WRONG":"x"}' },
    });
    await runDripStep(output.envoy, SEQ, baseDue(), output.config);
    expect(failureWrite(output.calls)[0]!.params[7]).toBe(false);
  });

  it("an agent turn that ends incomplete (requires_action: the agent's configuration) is transient", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
    });
    env.agent!.stream.mockImplementationOnce(async () => ({
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        yield { type: "session.status_idle", stop_reason: { type: "requires_action" } };
      },
    }));
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toMatchObject({ sent: false, reason: "generation_failed" });
    expect(failureWrite(env.calls)[0]!.params[7]).toBe(true);
  });

  it("a stream that ended with NO output is transient; text with no block is permanent", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
    });
    env.agent!.stream.mockImplementationOnce(async () => ({
      controller: new AbortController(),
      async *[Symbol.asyncIterator]() {
        // ends with no agent.message and no idle event
      },
    }));
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(failureWrite(env.calls)[0]!.params[7]).toBe(true);
  });

  it("the failure write is pinned on the step the enrollment is still on, and decides stop from THIS failure", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"WRONG":"x"}' },
    });
    await runDripStep(env.envoy, SEQ, baseDue({ stepIndex: 1, nextRunAt: new Date(0) }), env.config);
    const w = failureWrite(env.calls)[0]!;
    expect(w.text).toMatch(/AND current_step = \$9::int/);
    expect(w.params[8]).toBe(1);
    expect(w.text).toMatch(/\(NOT \$8::boolean AND permanent_failures >= \$4::int\) AS stop/);
  });

  it("a failure whose recording met a Node errno (EPIPE, not a SQLSTATE) writes nothing more", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    const query = env.envoy.db.execWrite.bind(env.envoy.db);
    vi.spyOn(env.envoy.db, "execWrite").mockImplementation(async (text, params) => {
      if (/failed_attempts/.test(text)) throw Object.assign(new Error("write EPIPE"), { code: "EPIPE" });
      return query(text, params);
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(env.calls.find((c) => /INTERVAL '1 hour'/.test(c.text))).toBeUndefined();
  });

  it("with no Resend key nothing is generated and nothing is recorded", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body(LONG) },
      resend: { enabled: false },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "resend_disabled" });
    expect(env.agent!.create).not.toHaveBeenCalled();
    expect(failureWrite(env.calls)).toHaveLength(0);
  });

  it("a failure written without migration 005 (42703) falls back to the old bookkeeping plus an hour's wait", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    const query = env.envoy.db.execWrite.bind(env.envoy.db);
    vi.spyOn(env.envoy.db, "execWrite").mockImplementation(async (text, params) => {
      if (/failed_attempts/.test(text)) throw Object.assign(new Error("no column"), { code: "42703" });
      return query(text, params);
    });
    await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    const fallback = env.calls.find((c) => /INTERVAL '1 hour'/.test(c.text));
    expect(fallback).toBeDefined();
    expect(fallback!.text).toMatch(/attempts = attempts \+ 1, last_error = \$3/);
    // Like the main path: only an ACTIVE enrollment's step is touched, the enrollment locked first.
    expect(fallback!.text).toMatch(/WITH enr AS \([\s\S]*FOR NO KEY UPDATE[\s\S]*EXISTS \(SELECT 1 FROM enr\)/);
  });

  it("the failure that reaches maxAttempts stops the enrollment, reported ONCE as `stopped`", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"WRONG":"x"}' },
      priorAttempts: 2,
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), { ...env.config, maxAttempts: 3 });
    expect(res).toEqual({ sent: false, reason: "stopped", detail: "agent output missing body" });
    expect(failureWrite(env.calls)[0]!.params[7]).toBe(false);
    expect(failureWrite(env.calls)[0]!.params[3]).toBe(3);
    expect(error).toHaveBeenCalledTimes(1);
    // The line carries no recipient address (R43).
    expect(JSON.stringify(error.mock.calls)).not.toContain("ada@example.com");
  });

  it.each([
    ["a transport error", { sendThrows: true }],
    ["a Resend 429", { sendError: true, sendStatus: 429 }],
    ["a Resend 503", { sendError: true, sendStatus: 503 }],
    ["a Resend 401 (the account's key)", { sendError: true, sendStatus: 401 }],
    ["a Resend 403 (the From domain)", { sendError: true, sendStatus: 403 }],
    ["a Resend 404 (the template)", { sendError: true, sendStatus: 404 }],
    ["a Resend error with no status", { sendError: true, sendStatus: null }],
  ] as const)("%s at the cap is transient: backed off, never stopped", async (_label, resend) => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend,
      priorAttempts: 5,
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), { ...env.config, maxAttempts: 3 });
    expect(res).toMatchObject({ sent: false, reason: "send_failed" });
    expect(failureWrite(env.calls)[0]!.params[7]).toBe(true);
  });

  it.each([
    [0, 1],
    [-1, 1],
    [2.5, 2],
    [Infinity, MAX_DRIP_MAX_ATTEMPTS],
    [MAX_DRIP_MAX_ATTEMPTS + 1, MAX_DRIP_MAX_ATTEMPTS],
    [Number.NaN, DEFAULT_DRIP_MAX_ATTEMPTS],
  ])("maxAttempts %s is clamped to %s", async (given, used) => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: body("Hi") },
      resend: { sendError: true },
    });
    await runDripStep(env.envoy, SEQ, baseDue(), { ...env.config, maxAttempts: given });
    expect(failureWrite(env.calls)[0]!.params[3]).toBe(used);
  });

});

// =============================================================================================
// Resend disabled (R43): silent no-op, step stays due.
// =============================================================================================

describe("runDripStep — Resend disabled (R43)", () => {
  it("no Resend key ⇒ resend_disabled no-op; the step is not advanced", async () => {
    const env = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      agent: { output: '{"body":"Hi"}' },
      resend: { enabled: false },
    });
    const res = await runDripStep(env.envoy, SEQ, baseDue(), env.config);
    expect(res).toEqual({ sent: false, reason: "resend_disabled" });
    expect(env.calls.find((c) => /UPDATE sdk_enrollments[\s\S]*current_step/i.test(c.text))).toBeUndefined();
  });
});
