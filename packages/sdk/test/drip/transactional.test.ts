import { describe, expect, it, vi } from "vitest";

import {
  sendTransactional,
  TransactionalSendError,
  SystemLaneViolation,
  type TransactionalSendInput,
  type TransactionalSendConfig,
} from "@sdk/drip/transactional.js";
import { createDb, type SdkPool } from "@sdk/db/pool.js";
import { createConsentMirror, type ConsentMirror } from "@sdk/consent/mirror.js";
import { createResendClientHandle, type ResendClientHandle } from "@sdk/resend/client.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";
import {
  verifyUnsubscribeToken,
  type UnsubscribeClaims,
} from "@sdk/consent/unsubscribe.js";

// U10 — transactional send (one-shot, non-AI). Mocks: a fake `pg` pool backing a REAL ConsentMirror
// (so the gate logic is exercised, not stubbed), a controllable Resend whose `emails.send` is a spy,
// and a hand-built Envoy handle (the U7 test's pattern). No real network/DB.

const NAMESPACE = "prod";
const UNSUB_SECRET = "unsub-secret-0123456789";
const UNSUB_URL = "https://app.example.com/api/envoy/unsubscribe";

// ---------------------------------------------------------------------------------------------
// Fake pool — backs the consent mirror's reads. `gate` only ever issues the SELECT against
// `sdk_topic_consent`; we seed a per-(contact, topicKey) consent row store.
// ---------------------------------------------------------------------------------------------

interface ConsentSeed {
  contact: string; // bare email (the mirror namespaces it before the SELECT)
  topicKey: string;
  topicId?: string | null;
  digest?: "opt_in" | "opt_out" | "unsubscribed";
  alert?: "opt_in" | "opt_out" | "unsubscribed";
  dirty?: boolean;
  /** GLOBAL `sdk_contacts.unsubscribed` flag — the gate's suppress-all check (default false). */
  unsubscribed?: boolean;
}

function fakePool(seed: ConsentSeed[] = []): {
  pool: SdkPool;
  calls: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
} {
  // Key on the NAMESPACED contact (matches what the mirror passes as $2).
  const rows = new Map<string, Record<string, unknown>>();
  // GLOBAL suppression flag store, keyed on the lower-cased bare email (matches the `sdk_contacts`
  // SELECT in ConsentMirror.gate → isGloballySuppressed). Default unsuppressed.
  const suppressed = new Map<string, boolean>();
  for (const s of seed) {
    const nsContact = `${NAMESPACE}:${s.contact}`;
    rows.set(`${nsContact}|${s.topicKey}`, {
      contact: nsContact,
      topic_key: s.topicKey,
      topic_id: s.topicId ?? null,
      digest_status: s.digest ?? "opt_in",
      alert_status: s.alert ?? "opt_in",
      dirty_since: s.dirty ? "2026-01-01" : null,
    });
    suppressed.set(s.contact.toLowerCase(), s.unsubscribed ?? false);
  }

  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];
  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();
      // The gate's FIRST query: the GLOBAL suppression flag (ConsentMirror.isGloballySuppressed).
      // Without this, the suppress-all gate is a no-op (the SELECT falls through to the empty
      // default and reads as not-suppressed).
      if (/SELECT unsubscribed[\s\S]*FROM sdk_contacts[\s\S]*lower\(email\)/i.test(t)) {
        const [, email] = (params ?? []) as unknown[];
        const flag = suppressed.get(String(email).toLowerCase()) ?? false;
        return { rows: [{ unsubscribed: flag }] } as never;
      }
      if (t.startsWith("SELECT contact, topic_key, topic_id, digest_status")) {
        const [, contact, topicKey] = params as [string, string, string];
        const row = rows.get(`${contact}|${topicKey}`);
        return { rows: row ? [row] : [] } as never;
      }
      return { rows: [] } as never;
    }),
  };
  return { pool, calls };
}

// ---------------------------------------------------------------------------------------------
// Fake Resend with a controllable emails.send spy.
// ---------------------------------------------------------------------------------------------

interface ResendOpts {
  enabled?: boolean;
  sendError?: boolean;
  sendThrows?: boolean;
}

function fakeResend(opts: ResendOpts = {}): {
  handle: ResendClientHandle;
  emailsSend: ReturnType<typeof vi.fn>;
} {
  const err = (m: string) => ({ message: m, statusCode: 422, name: "validation_error" });
  let n = 0;
  const emailsSend = vi.fn(async () => {
    if (opts.sendThrows) throw new Error("network down");
    if (opts.sendError) return { data: null, error: err("send refused") };
    n += 1;
    return { data: { id: `email_${n}` }, error: null };
  });

  const handle = createResendClientHandle(opts.enabled === false ? undefined : "re_test_key");
  if (opts.enabled !== false) {
    vi.spyOn(handle, "client").mockReturnValue({
      emails: { send: emailsSend },
    } as never);
  }
  return { handle, emailsSend };
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
    unsubscribeSecret: UNSUB_SECRET,
    baseSegmentId: "seg_base",
    agent: undefined,
    aiFieldAllowList: Object.freeze([]),
    streams: Object.freeze({}),
    systemTemplateIds: new Set<string>(),
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

function setup(opts: {
  resend?: ResendOpts;
  seed?: ConsentSeed[];
  configOverrides?: Partial<ResolvedEnvoyConfig>;
} = {}): {
  envoy: Envoy;
  mirror: ConsentMirror;
  config: TransactionalSendConfig;
  emailsSend: ReturnType<typeof vi.fn>;
  calls: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
} {
  const fp = fakePool(opts.seed);
  const { handle, emailsSend } = fakeResend(opts.resend);
  const envoy = makeEnvoy(fp.pool, handle, opts.configOverrides);
  const mirror = createConsentMirror(envoy.db, envoy.resend);
  const config: TransactionalSendConfig = { mirror, unsubscribeBaseUrl: UNSUB_URL };
  return { envoy, mirror, config, emailsSend, calls: fp.calls };
}

const baseInput = (over: Partial<TransactionalSendInput> = {}): TransactionalSendInput => ({
  email: "ada@example.com",
  templateId: "tmpl_welcome",
  variables: { FIRST_NAME: "Ada" },
  stream: "digest",
  topicKey: "welcome",
  ...over,
});

// =============================================================================================
// Happy path — R46: passes template id + variables + List-Unsubscribe header + idempotency key.
// =============================================================================================

describe("sendTransactional — happy path (R46)", () => {
  it("Covers R46. Happy: sends with template id + variables + List-Unsubscribe header + idempotency key", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });

    const res = await sendTransactional(
      env.envoy,
      baseInput({ idempotencyKey: "idem-123", from: "hi@app.example.com" }),
      config
    );

    expect(res).toEqual({ sent: true, emailId: "email_1" });
    expect(emailsSend).toHaveBeenCalledTimes(1);

    const [payload, requestOptions] = emailsSend.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, unknown> | undefined,
    ];

    // template id + variables ride the body `template` arm (not inline html/text). UNSUBSCRIBE_URL is
    // injected (standard lane) so a template can render a visible in-body unsubscribe link.
    const tmpl = payload.template as { id: string; variables: Record<string, string> };
    expect(tmpl.id).toBe("tmpl_welcome");
    expect(tmpl.variables.FIRST_NAME).toBe("Ada");
    expect(tmpl.variables.UNSUBSCRIBE_URL).toMatch(/^https:\/\/app\.example\.com\/api\/envoy\/unsubscribe\?token=/);
    expect(payload.to).toBe("ada@example.com");
    expect(payload.from).toBe("hi@app.example.com");

    // List-Unsubscribe one-click headers present (R33).
    const headers = payload.headers as Record<string, string>;
    expect(headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(headers["List-Unsubscribe"]).toMatch(
      /^<https:\/\/app\.example\.com\/api\/envoy\/unsubscribe\?token=/
    );

    // Idempotency key is the REQUEST OPTION (Idempotency-Key header), NOT a body field (R46).
    expect(requestOptions).toEqual({ idempotencyKey: "idem-123" });
    expect(payload.idempotencyKey).toBeUndefined();
  });

  it("the List-Unsubscribe token is a valid, stream+topic-scoped, signed token", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });

    await sendTransactional(env.envoy, baseInput({ from: "hi@app.example.com" }), config);

    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    const headerVal = (payload.headers as Record<string, string>)["List-Unsubscribe"];
    const token = decodeURIComponent(
      /token=([^>]+)>/.exec(headerVal)![1]!
    );

    const verdict = verifyUnsubscribeToken(token, UNSUB_SECRET);
    expect(verdict.ok).toBe(true);
    const claims = (verdict as { ok: true; claims: UnsubscribeClaims }).claims;
    expect(claims.contact).toBe("ada@example.com");
    expect(claims.topicKey).toBe("welcome");
    expect(claims.stream).toBe("digest");
  });

  it("falls back to the stream's configured `from` default when none is passed", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      configOverrides: {
        streams: Object.freeze({ digest: { from: "digest@app.example.com" } }),
      },
    });

    const res = await sendTransactional(env.envoy, baseInput(), config);
    expect(res.sent).toBe(true);
    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.from).toBe("digest@app.example.com");
  });

  it("injects only UNSUBSCRIBE_URL when no other variables are supplied (standard lane)", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });

    await sendTransactional(
      env.envoy,
      baseInput({ variables: undefined, from: "hi@app.example.com" }),
      config
    );
    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    const tmpl = payload.template as { id: string; variables: Record<string, string> };
    expect(tmpl.id).toBe("tmpl_welcome");
    expect(Object.keys(tmpl.variables)).toEqual(["UNSUBSCRIBE_URL"]);
    expect(tmpl.variables.UNSUBSCRIBE_URL).toMatch(/token=/);
  });

  it("omits the request options entirely when no idempotency key is supplied", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });

    await sendTransactional(env.envoy, baseInput({ from: "hi@app.example.com" }), config);
    const requestOptions = emailsSend.mock.calls[0]![1];
    expect(requestOptions).toBeUndefined();
  });

  it("forwards an explicit subject + replyTo override onto the payload", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });

    await sendTransactional(
      env.envoy,
      baseInput({ from: "hi@app.example.com", subject: "Welcome!", replyTo: "reply@app.example.com" }),
      config
    );
    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.subject).toBe("Welcome!");
    expect(payload.replyTo).toBe("reply@app.example.com");
  });

  it("uses the alert stream's default + scopes the token to the alert stream", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "law-change", alert: "opt_in" }],
      configOverrides: {
        streams: Object.freeze({ alert: { from: "alerts@app.example.com" } }),
      },
    });

    const res = await sendTransactional(
      env.envoy,
      baseInput({ stream: "alert", topicKey: "law-change" }),
      config
    );
    expect(res.sent).toBe(true);
    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.from).toBe("alerts@app.example.com");
    const headerVal = (payload.headers as Record<string, string>)["List-Unsubscribe"];
    const token = decodeURIComponent(/token=([^>]+)>/.exec(headerVal)![1]!);
    const verdict = verifyUnsubscribeToken(token, UNSUB_SECRET);
    expect((verdict as { ok: true; claims: UnsubscribeClaims }).claims.stream).toBe("alert");
  });
});

// =============================================================================================
// Error — R45/R46: a call with no stream (or other missing required input) is rejected.
// =============================================================================================

describe("sendTransactional — required-input rejection (R45/R46)", () => {
  it("Covers R46. Error: a call with no `stream` is rejected and nothing is sent", async () => {
    const { config, emailsSend, ...env } = setup();
    await expect(
      sendTransactional(
        env.envoy,
        // stream omitted — cast through unknown so an untyped JS caller is simulated.
        baseInput({ stream: undefined as never }),
        config
      )
    ).rejects.toBeInstanceOf(TransactionalSendError);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Error: an unknown stream value is rejected", async () => {
    const { config, emailsSend, ...env } = setup();
    await expect(
      sendTransactional(env.envoy, baseInput({ stream: "marketing" as never }), config)
    ).rejects.toThrow(/stream/);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Error: a missing topicKey is rejected (no place to scope the opt-out)", async () => {
    const { config, emailsSend, ...env } = setup();
    await expect(
      sendTransactional(env.envoy, baseInput({ topicKey: "" }), config)
    ).rejects.toThrow(/topicKey/);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Error: a missing templateId is rejected", async () => {
    const { config, emailsSend, ...env } = setup();
    await expect(
      sendTransactional(env.envoy, baseInput({ templateId: "" }), config)
    ).rejects.toThrow(/templateId/);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Error: a missing email is rejected", async () => {
    const { config, emailsSend, ...env } = setup();
    await expect(
      sendTransactional(env.envoy, baseInput({ email: "" }), config)
    ).rejects.toThrow(/email/);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Error: no From (neither explicit nor stream default) is rejected fail-loud", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    // streams default is empty {} and no `from` passed.
    await expect(
      sendTransactional(env.envoy, baseInput(), config)
    ).rejects.toThrow(/From address/);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Error: a missing unsubscribeBaseUrl is rejected", async () => {
    const { ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    await expect(
      sendTransactional(env.envoy, baseInput({ from: "hi@app.example.com" }), {
        mirror: env.mirror,
        unsubscribeBaseUrl: "",
      })
    ).rejects.toThrow(/unsubscribeBaseUrl/);
  });

  it("Error: a non-https unsubscribeBaseUrl is rejected by the header builder", async () => {
    const { ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    await expect(
      sendTransactional(env.envoy, baseInput({ from: "hi@app.example.com" }), {
        mirror: env.mirror,
        unsubscribeBaseUrl: "http://insecure.example.com/unsub",
      })
    ).rejects.toThrow(/https/);
  });
});

// =============================================================================================
// Edge — R26: a suppressed contact is not sent.
// =============================================================================================

describe("sendTransactional — mirror gate (R26)", () => {
  it("Edge: a topic-scoped opt_out for this stream is NOT sent", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_out" }],
    });

    const res = await sendTransactional(
      env.envoy,
      baseInput({ from: "hi@app.example.com" }),
      config
    );
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Edge: a global unsubscribe (unsubscribed on either stream) is NOT sent", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [
        { contact: "ada@example.com", topicKey: "welcome", digest: "unsubscribed", alert: "unsubscribed" },
      ],
    });
    const res = await sendTransactional(
      env.envoy,
      baseInput({ from: "hi@app.example.com" }),
      config
    );
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Edge: a contact with NO provisioned consent row is denied (deny-by-default)", async () => {
    const { config, emailsSend, ...env } = setup({ seed: [] });
    const res = await sendTransactional(
      env.envoy,
      baseInput({ from: "hi@app.example.com" }),
      config
    );
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Edge: an unsubscribed alert stream blocks a digest send to the same topic (suppress-all dominates)", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [
        { contact: "ada@example.com", topicKey: "welcome", digest: "opt_in", alert: "unsubscribed" },
      ],
    });
    const res = await sendTransactional(
      env.envoy,
      baseInput({ stream: "digest", from: "hi@app.example.com" }),
      config
    );
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("Edge: a GLOBALLY-suppressed contact with a stale opt_in row is blocked on BOTH streams (R22/R26)", async () => {
    // The global `sdk_contacts.unsubscribed` flag (bounce/complaint/GDPR/hosted-page) dominates a
    // per-topic row that still reads opt_in on both lanes. Without the sdk_contacts handler the
    // suppress-all gate is a no-op and this contact would wrongly be sent to.
    const { config, emailsSend, ...env } = setup({
      seed: [
        {
          contact: "ada@example.com",
          topicKey: "welcome",
          digest: "opt_in",
          alert: "opt_in",
          unsubscribed: true,
        },
      ],
    });

    const digestRes = await sendTransactional(
      env.envoy,
      baseInput({ stream: "digest", from: "hi@app.example.com" }),
      config
    );
    expect(digestRes).toEqual({ sent: false, reason: "suppressed" });

    const alertRes = await sendTransactional(
      env.envoy,
      baseInput({ stream: "alert", from: "hi@app.example.com" }),
      config
    );
    expect(alertRes).toEqual({ sent: false, reason: "suppressed" });

    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("the gate is consulted BEFORE any Resend call (no send on an opted-in but the gate is read first)", async () => {
    const { config, emailsSend, calls, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    await sendTransactional(env.envoy, baseInput({ from: "hi@app.example.com" }), config);
    // The consent SELECT was issued (gate read) and the send happened after.
    expect(calls.some((c) => c.text.trim().startsWith("SELECT contact, topic_key"))).toBe(true);
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================================
// Edge — R43: no Resend key ⇒ silent no-op, never throws.
// =============================================================================================

describe("sendTransactional — Resend disabled (R43)", () => {
  it("Edge: with no Resend API key the send is a silent no-op (never throws)", async () => {
    const { config, emailsSend, ...env } = setup({
      resend: { enabled: false },
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    const res = await sendTransactional(
      env.envoy,
      baseInput({ from: "hi@app.example.com" }),
      config
    );
    expect(res).toEqual({ sent: false, reason: "resend_disabled" });
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("a suppressed contact short-circuits even before the disabled-Resend check (gate dominates)", async () => {
    const { config, emailsSend, ...env } = setup({
      resend: { enabled: false },
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_out" }],
    });
    const res = await sendTransactional(
      env.envoy,
      baseInput({ from: "hi@app.example.com" }),
      config
    );
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(emailsSend).not.toHaveBeenCalled();
  });
});

// =============================================================================================
// Error — a Resend in-band error / thrown transport error fails loud (no later tick to retry).
// =============================================================================================

describe("sendTransactional — Resend send failure (R46 fail-loud)", () => {
  it("Error: an in-band Resend error throws TransactionalSendError", async () => {
    const { config, emailsSend, ...env } = setup({
      resend: { sendError: true },
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    await expect(
      sendTransactional(env.envoy, baseInput({ from: "hi@app.example.com" }), config)
    ).rejects.toBeInstanceOf(TransactionalSendError);
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("Error: a thrown transport error is wrapped as TransactionalSendError (no PII leak)", async () => {
    const { config, ...env } = setup({
      resend: { sendThrows: true },
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    await expect(
      sendTransactional(env.envoy, baseInput({ from: "hi@app.example.com" }), config)
    ).rejects.toThrow(/emails\.send threw/);
  });

  it("a thrown send error message does not contain the recipient email (R43)", async () => {
    const { config, ...env } = setup({
      resend: { sendThrows: true },
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    let caught: unknown;
    try {
      await sendTransactional(env.envoy, baseInput({ from: "hi@app.example.com" }), config);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(TransactionalSendError);
    expect((caught as Error).message).not.toContain("ada@example.com");
  });
});

// ---------------------------------------------------------------------------------------------
// P2 types — compile-time guard that the `payload as CreateEmailOptions` cast (engine.ts +
// transactional.ts) is a CHECKED assertion, not an `as never` that suppresses all payload
// typechecking. These statements are evaluated by `tsc --noEmit` (test/ is in the tsconfig
// include): the @ts-expect-error lines fail the typecheck if the cast ever stops catching a
// malformed payload field. They never run at runtime.
// ---------------------------------------------------------------------------------------------
{
  type CreateEmailOptions = Parameters<
    import("resend").Resend["emails"]["send"]
  >[0];

  // The template-only payload both send sites build IS structurally assignable to the named target.
  const goodTemplatePayload = {
    to: "ada@example.com",
    from: "hi@app.example.com",
    template: { id: "tmpl_welcome", variables: { name: "Ada" } },
    headers: { "List-Unsubscribe": "<https://x>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
  };
  const _assignable: CreateEmailOptions = goodTemplatePayload as CreateEmailOptions;
  void _assignable;

  // A payload with a wrong-typed `to` must NOT pass `as CreateEmailOptions` — proving the cast
  // checks the payload shape (an `as never` here would compile and this @ts-expect-error would be
  // flagged as unused, failing the typecheck).
  const malformed = { to: 123, from: "hi@app.example.com", template: { id: "t" } };
  // @ts-expect-error - `to: number` is not assignable to CreateEmailOptions['to'] (string | string[]).
  const _rejected: CreateEmailOptions = malformed as CreateEmailOptions;
  void _rejected;
}

// =============================================================================================
// U1 — attachments are forwarded onto the Resend payload (the booking .ics path).
// =============================================================================================

const ICS = {
  filename: "invite.ics",
  content: "BEGIN:VCALENDAR\nEND:VCALENDAR",
  contentType: "text/calendar",
};

describe("sendTransactional — attachments (U1)", () => {
  it("forwards `attachments` onto the Resend payload", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    await sendTransactional(
      env.envoy,
      baseInput({ from: "hi@app.example.com", attachments: [ICS] }),
      config
    );
    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.attachments).toEqual([ICS]);
  });

  it("omits `attachments` from the payload when none or an empty array is given", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
    });
    await sendTransactional(
      env.envoy,
      baseInput({ from: "hi@app.example.com", attachments: [] }),
      config
    );
    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.attachments).toBeUndefined();
  });
});

// =============================================================================================
// U2 / KTD7 — the non-gated `system` lane: floor-respecting, no List-Unsubscribe, allow-listed.
// =============================================================================================

describe("sendTransactional — system lane (U2/KTD7)", () => {
  const SYS_CFG: Partial<ResolvedEnvoyConfig> = {
    systemTemplateIds: new Set<string>(["tmpl_receipt"]),
  };
  const systemInput = (over: Record<string, unknown> = {}): TransactionalSendInput =>
    ({
      email: "ada@example.com",
      templateId: "tmpl_receipt",
      system: true,
      from: "receipts@app.example.com",
      ...over,
    }) as TransactionalSendInput;

  it("delivers to a contact opted OUT of the topic (a marketing opt-out cannot drop a receipt)", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_out" }],
      configOverrides: SYS_CFG,
    });
    const res = await sendTransactional(env.envoy, systemInput(), config);
    expect(res.sent).toBe(true);
    expect(emailsSend).toHaveBeenCalledTimes(1);
  });

  it("is SUPPRESSED for a globally-suppressed contact (the floor still holds on the system lane)", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in", unsubscribed: true }],
      configOverrides: SYS_CFG,
    });
    const res = await sendTransactional(env.envoy, systemInput(), config);
    expect(res).toEqual({ sent: false, reason: "suppressed" });
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("carries NO List-Unsubscribe header (legitimate-interest mail is not unsubscribable)", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_out" }],
      configOverrides: SYS_CFG,
    });
    await sendTransactional(env.envoy, systemInput(), config);
    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.headers).toBeUndefined();
  });

  it("throws SystemLaneViolation when the templateId is not in systemTemplateIds (marketing cannot ride the lane)", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      configOverrides: SYS_CFG,
    });
    await expect(
      sendTransactional(env.envoy, systemInput({ templateId: "tmpl_marketing" }), config)
    ).rejects.toBeInstanceOf(SystemLaneViolation);
    expect(emailsSend).not.toHaveBeenCalled();
  });

  it("needs no stream/topicKey but still requires a From (system send without a stream)", async () => {
    const { config, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_in" }],
      configOverrides: SYS_CFG,
    });
    await expect(
      sendTransactional(env.envoy, systemInput({ from: undefined }), config)
    ).rejects.toThrow(/From address/);
  });

  it("carries attachments on the system lane (the .ics receipt) with no unsubscribe header", async () => {
    const { config, emailsSend, ...env } = setup({
      seed: [{ contact: "ada@example.com", topicKey: "welcome", digest: "opt_out" }],
      configOverrides: SYS_CFG,
    });
    await sendTransactional(env.envoy, systemInput({ attachments: [ICS] }), config);
    const payload = emailsSend.mock.calls[0]![0] as Record<string, unknown>;
    expect(payload.attachments).toEqual([ICS]);
    expect(payload.headers).toBeUndefined();
  });
});
