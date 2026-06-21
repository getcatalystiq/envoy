import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

import {
  createWebhookReceiver,
  ingestEvent,
  extractRecipientEmail,
  type ResendWebhookEvent,
} from "@sdk/route/webhook.js";
import { createEnvoyHandler } from "@sdk/route/handler.js";
import { createDb, type SdkPool } from "@sdk/db/pool.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";

// ---------------------------------------------------------------------------------------------
// In-memory fake of the `sdk_contacts` slice the webhook receiver touches. Keyed by lower(email)
// within a namespace, it models exactly the three statements `webhook.ts` issues:
//   - SELECT email FROM sdk_contacts WHERE namespace = $1 AND lower(email) = $2     (resolve)
//   - UPDATE sdk_contacts SET dirty_since = NOW() …                                 (reconcile)
//   - UPDATE sdk_contacts SET unsubscribed = TRUE, dirty_since = NOW() …            (suppress)
// ---------------------------------------------------------------------------------------------

interface ContactRow {
  email: string;
  unsubscribed: boolean;
  dirty: boolean;
}

function fakeContactsPool(seed: string[] = []) {
  const contacts = new Map<string, ContactRow>();
  for (const email of seed) {
    contacts.set(email.toLowerCase(), { email, unsubscribed: false, dirty: false });
  }
  const calls: Array<{ text: string; params?: ReadonlyArray<unknown> }> = [];

  const pool: SdkPool = {
    query: vi.fn(async (text: string, params?: ReadonlyArray<unknown>) => {
      calls.push({ text, params });
      const t = text.trim();

      if (t.startsWith("SELECT email FROM sdk_contacts")) {
        const [, email] = params as [string, string];
        const row = contacts.get(email);
        return { rows: row ? [{ email: row.email }] : [] } as never;
      }

      if (t.startsWith("UPDATE sdk_contacts SET unsubscribed = TRUE")) {
        const [, email] = params as [string, string];
        const row = contacts.get(email);
        if (row) {
          row.unsubscribed = true;
          row.dirty = true;
        }
        return { rows: row ? [row] : [] } as never;
      }

      if (t.startsWith("UPDATE sdk_contacts SET dirty_since = NOW()")) {
        const [, email] = params as [string, string];
        const row = contacts.get(email);
        if (row) row.dirty = true;
        return { rows: row ? [row] : [] } as never;
      }

      return { rows: [] } as never;
    }),
  };

  return { pool, contacts, calls };
}

const NAMESPACE = "prod";

function makeEnvoy(seed: string[] = []): {
  envoy: Envoy;
  contacts: Map<string, ContactRow>;
  calls: Array<{ text: string; params?: ReadonlyArray<unknown> }>;
  redactSpy: ReturnType<typeof vi.fn>;
} {
  const { pool, contacts, calls } = fakeContactsPool(seed);
  const db = createDb(pool, NAMESPACE);
  const config = {
    installNamespace: NAMESPACE,
    resendApiKey: undefined,
    webhookSecret: WEBHOOK_SECRET,
    cronSecret: "cron-secret-0123456789",
    unsubscribeSecret: "unsub-secret-0123456789",
    baseSegmentId: "seg_base",
    agent: undefined,
    aiFieldAllowList: Object.freeze([]),
    streams: Object.freeze({}),
  } as ResolvedEnvoyConfig;

  // A redact spy that asserts no full email reaches a log site: it reduces emails to a hint.
  const redactSpy = vi.fn((v: unknown) => {
    const s = String(v);
    return s.includes("@") ? `${s[0]}***@redacted` : "***";
  });

  const envoy: Envoy = {
    config,
    db,
    resend: { enabled: false, client: () => null } as Envoy["resend"],
    assertNamespaceFingerprint: async () => {},
    redact: redactSpy,
  };

  return { envoy, contacts, calls, redactSpy };
}

// ---------------------------------------------------------------------------------------------
// Svix signing helpers (mirrors test/route/handler.test.ts so the integration test goes through the
// real Svix-verify gate in createEnvoyHandler).
// ---------------------------------------------------------------------------------------------

const WEBHOOK_SECRET = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");

function signedWebhook(path: string, body: string, secret = WEBHOOK_SECRET): Request {
  const wh = new Webhook(secret);
  const id = "msg_test_1";
  const ts = Math.floor(Date.now() / 1000);
  const signature = wh.sign(id, new Date(ts * 1000), body);
  return new Request(`https://app.example.com${path}`, {
    method: "POST",
    headers: {
      "svix-id": id,
      "svix-timestamp": String(ts),
      "svix-signature": signature,
      "content-type": "application/json",
    },
    body,
  });
}

function ev(type: string, data: Record<string, unknown>): ResendWebhookEvent {
  return { type, created_at: new Date().toISOString(), data };
}

function rawRequest(event: ResendWebhookEvent): Request {
  return new Request("https://app.example.com/api/envoy/webhook", {
    method: "POST",
    body: JSON.stringify(event),
  });
}

// ---------------------------------------------------------------------------------------------
// extractRecipientEmail — payload extraction (defensive)
// ---------------------------------------------------------------------------------------------

describe("extractRecipientEmail", () => {
  it("reads data.email from a contact event and lowercases it", () => {
    expect(extractRecipientEmail({ email: "Marko@Example.com" })).toBe("marko@example.com");
  });

  it("reads the first address from an email event's `to` array", () => {
    expect(extractRecipientEmail({ to: ["a@example.com", "b@example.com"] })).toBe("a@example.com");
  });

  it("tolerates `to` being a bare string", () => {
    expect(extractRecipientEmail({ to: "solo@example.com" })).toBe("solo@example.com");
  });

  it("returns null when no recipient is present", () => {
    expect(extractRecipientEmail({})).toBeNull();
    expect(extractRecipientEmail(undefined)).toBeNull();
    expect(extractRecipientEmail({ to: [123, null] })).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// contact.* — change signal → reconcile (R41)
// ---------------------------------------------------------------------------------------------

describe("contact.* ingest (R41 — change signal → reconcile)", () => {
  it("Happy: a contact.updated for a known contact enqueues a reconcile (marks dirty, no suppress)", async () => {
    const { envoy, contacts } = makeEnvoy(["user@example.com"]);
    const result = await ingestEvent(
      envoy,
      ev("contact.updated", { id: "ct_1", email: "user@example.com", unsubscribed: false })
    );

    expect(result.kind).toBe("contact");
    expect(result.contactMatched).toBe(true);
    expect(result.reconcileEnqueued).toBe(true);
    expect(result.suppressed).toBe(false);
    expect(contacts.get("user@example.com")?.dirty).toBe(true);
    expect(contacts.get("user@example.com")?.unsubscribed).toBe(false);
  });

  it("Edge: a payload global unsubscribed=true suppresses the contact across ALL topics", async () => {
    const { envoy, contacts } = makeEnvoy(["user@example.com"]);
    const result = await ingestEvent(
      envoy,
      ev("contact.updated", { id: "ct_1", email: "user@example.com", unsubscribed: true })
    );

    expect(result.kind).toBe("contact");
    expect(result.suppressed).toBe(true);
    expect(result.reconcileEnqueued).toBe(true); // still re-pushed by the sweep
    expect(contacts.get("user@example.com")?.unsubscribed).toBe(true);
  });

  it("Edge: a contact event whose email matches no contact is acked-and-ignored (no 500, no write)", async () => {
    const { envoy, contacts, calls } = makeEnvoy([]); // no seeded contacts
    const result = await ingestEvent(
      envoy,
      ev("contact.created", { id: "ct_x", email: "ghost@example.com" })
    );

    expect(result.kind).toBe("ignored");
    expect(result.contactMatched).toBe(false);
    expect(result.reconcileEnqueued).toBe(false);
    expect(result.suppressed).toBe(false);
    expect(contacts.size).toBe(0);
    // only the SELECT ran — no UPDATE was attempted against a missing contact
    expect(calls.filter((c) => c.text.trim().startsWith("UPDATE"))).toHaveLength(0);
  });

  it("Edge: a contact event with no resolvable email is acked-and-ignored", async () => {
    const { envoy } = makeEnvoy(["user@example.com"]);
    const result = await ingestEvent(envoy, ev("contact.deleted", { id: "ct_only_id" }));
    expect(result.contactMatched).toBe(false);
    expect(result.reconcileEnqueued).toBe(false);
  });

  it("resolves contacts case-insensitively (Resend may echo a different case)", async () => {
    const { envoy, contacts } = makeEnvoy(["User@Example.com"]);
    const result = await ingestEvent(
      envoy,
      ev("contact.updated", { email: "user@example.com", unsubscribed: false })
    );
    expect(result.contactMatched).toBe(true);
    expect(contacts.get("user@example.com")?.dirty).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// email.* — delivery/suppression analytics (R22)
// ---------------------------------------------------------------------------------------------

describe("email.* ingest (R22 — suppression vs analytics)", () => {
  it("Regression-shape: email.bounced updates suppression and does NOT hit the contact-reconcile path", async () => {
    const { envoy, contacts } = makeEnvoy(["dead@example.com"]);
    const result = await ingestEvent(
      envoy,
      ev("email.bounced", { email_id: "e1", to: ["dead@example.com"] })
    );

    expect(result.kind).toBe("suppression");
    expect(result.suppressed).toBe(true);
    expect(result.reconcileEnqueued).toBe(false); // never the contact-reconcile branch
    expect(contacts.get("dead@example.com")?.unsubscribed).toBe(true);
  });

  it("email.complained suppresses the recipient", async () => {
    const { envoy, contacts } = makeEnvoy(["angry@example.com"]);
    const result = await ingestEvent(
      envoy,
      ev("email.complained", { email_id: "e2", to: ["angry@example.com"] })
    );
    expect(result.kind).toBe("suppression");
    expect(contacts.get("angry@example.com")?.unsubscribed).toBe(true);
  });

  it("a positive delivery signal (email.delivered) is observed as analytics, writes no suppression", async () => {
    const { envoy, contacts, calls } = makeEnvoy(["ok@example.com"]);
    const result = await ingestEvent(
      envoy,
      ev("email.delivered", { email_id: "e3", to: ["ok@example.com"] })
    );

    expect(result.kind).toBe("analytics");
    expect(result.suppressed).toBe(false);
    expect(result.reconcileEnqueued).toBe(false);
    expect(contacts.get("ok@example.com")?.unsubscribed).toBe(false);
    // analytics branch never writes (no events table) — no UPDATE issued
    expect(calls.filter((c) => c.text.trim().startsWith("UPDATE"))).toHaveLength(0);
  });

  it("email.opened is observed as analytics, not suppression", async () => {
    const { envoy } = makeEnvoy(["ok@example.com"]);
    const result = await ingestEvent(envoy, ev("email.opened", { email_id: "e4", to: ["ok@example.com"] }));
    expect(result.kind).toBe("analytics");
  });

  it("a suppression event for an unknown recipient is acked-and-ignored (no write)", async () => {
    const { envoy, calls } = makeEnvoy([]);
    const result = await ingestEvent(
      envoy,
      ev("email.bounced", { email_id: "e5", to: ["stranger@example.com"] })
    );
    expect(result.kind).toBe("ignored");
    expect(result.suppressed).toBe(false);
    expect(calls.filter((c) => c.text.trim().startsWith("UPDATE"))).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------
// Unknown / foreign events — ack-and-ignore (R41 fail-safe)
// ---------------------------------------------------------------------------------------------

describe("unknown / foreign events", () => {
  it("an unknown event type is acked-and-ignored", async () => {
    const { envoy } = makeEnvoy(["user@example.com"]);
    const result = await ingestEvent(envoy, ev("domain.created", { name: "x" }));
    expect(result.kind).toBe("ignored");
    expect(result.reconcileEnqueued).toBe(false);
    expect(result.suppressed).toBe(false);
  });

  it("an event with no type is acked-and-ignored", async () => {
    const { envoy } = makeEnvoy([]);
    const result = await ingestEvent(envoy, { data: {} } as ResendWebhookEvent);
    expect(result.kind).toBe("ignored");
  });
});

// ---------------------------------------------------------------------------------------------
// createWebhookReceiver — the route seam (always 2xx for processable/ignorable; never 500 on junk)
// ---------------------------------------------------------------------------------------------

describe("createWebhookReceiver (route seam)", () => {
  it("returns 200 and the ingest result for a contact change signal", async () => {
    const { envoy, contacts } = makeEnvoy(["user@example.com"]);
    const receiver = createWebhookReceiver(envoy);
    const res = await receiver(rawRequest(ev("contact.updated", { email: "user@example.com" })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string; reconcileEnqueued: boolean };
    expect(body.kind).toBe("contact");
    expect(body.reconcileEnqueued).toBe(true);
    expect(contacts.get("user@example.com")?.dirty).toBe(true);
  });

  it("Never 500: a malformed JSON body is acked-and-ignored with 200", async () => {
    const { envoy } = makeEnvoy([]);
    const receiver = createWebhookReceiver(envoy);
    const res = await receiver(
      new Request("https://app.example.com/api/envoy/webhook", { method: "POST", body: "not json{" })
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { kind: string };
    expect(body.kind).toBe("ignored");
  });

  it("Never 500: a non-object JSON body (array) is acked-and-ignored with 200", async () => {
    const { envoy } = makeEnvoy([]);
    const receiver = createWebhookReceiver(envoy);
    const res = await receiver(
      new Request("https://app.example.com/api/envoy/webhook", { method: "POST", body: "[1,2,3]" })
    );
    expect(res.status).toBe(200);
  });

  it("surfaces a DB failure as 500 (the signature was valid; the write is ours to retry) and redacts the log", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    // A pool whose resolve query throws an error that itself contains a full email address.
    const throwingPool: SdkPool = {
      query: vi.fn(async () => {
        throw new Error("db down: user@example.com leaked");
      }),
    };
    const redactSpy = vi.fn((v: unknown) => {
      const s = String(v);
      return s.includes("@") ? `${s[0]}***@redacted` : "***";
    });
    const envoy: Envoy = {
      config: { installNamespace: NAMESPACE } as ResolvedEnvoyConfig,
      db: createDb(throwingPool, NAMESPACE),
      resend: { enabled: false, client: () => null } as Envoy["resend"],
      assertNamespaceFingerprint: async () => {},
      redact: redactSpy,
    };

    const receiver = createWebhookReceiver(envoy);
    const res = await receiver(rawRequest(ev("contact.updated", { email: "user@example.com" })));
    expect(res.status).toBe(500);
    // The error message (which contained a full email) was passed through redact before logging.
    expect(redactSpy).toHaveBeenCalled();
    // No console.error argument carries the unredacted full email.
    const loggedArgs = (errSpy.mock.calls[0] ?? []).map(String).join(" ");
    expect(loggedArgs).not.toContain("user@example.com");
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------------------------
// Integration: through the real Svix-verify gate (U4) → U5 receiver
// ---------------------------------------------------------------------------------------------

describe("integration via createEnvoyHandler (Svix-verified)", () => {
  it("Happy: a Svix-valid contact.updated resolves the contact and enqueues a reconcile", async () => {
    const { envoy, contacts } = makeEnvoy(["user@example.com"]);
    const h = createEnvoyHandler({
      envoy,
      authorize: () => false, // proves the webhook path bypasses host authorize
      webhook: createWebhookReceiver(envoy),
    });
    const body = JSON.stringify(ev("contact.updated", { email: "user@example.com" }));
    const res = await h.POST(signedWebhook("/api/envoy/webhook", body));
    expect(res.status).toBe(200);
    expect(contacts.get("user@example.com")?.dirty).toBe(true);
  });

  it("Error: an unverified (bad Svix) webhook returns 401 and writes nothing", async () => {
    const { envoy, contacts, calls } = makeEnvoy(["user@example.com"]);
    const h = createEnvoyHandler({
      envoy,
      authorize: () => true,
      webhook: createWebhookReceiver(envoy),
    });
    const body = JSON.stringify(ev("contact.updated", { email: "user@example.com", unsubscribed: true }));
    // Sign with a DIFFERENT secret → forged.
    const forged = signedWebhook(
      "/api/envoy/webhook",
      body,
      "whsec_" + Buffer.from("an-entirely-different-secret-key!").toString("base64")
    );
    const res = await h.POST(forged);
    expect(res.status).toBe(401);
    expect(contacts.get("user@example.com")?.unsubscribed).toBe(false);
    expect(calls).toHaveLength(0); // receiver never ran → no DB touched
  });

  it("Regression-shape: a Svix-valid email.bounced suppresses and does not enqueue a reconcile", async () => {
    const { envoy, contacts } = makeEnvoy(["dead@example.com"]);
    const h = createEnvoyHandler({
      envoy,
      authorize: () => true,
      webhook: createWebhookReceiver(envoy),
    });
    const body = JSON.stringify(ev("email.bounced", { email_id: "e9", to: ["dead@example.com"] }));
    const res = await h.POST(signedWebhook("/api/envoy/webhook", body));
    expect(res.status).toBe(200);
    const out = (await res.json()) as { kind: string; reconcileEnqueued: boolean };
    expect(out.kind).toBe("suppression");
    expect(out.reconcileEnqueued).toBe(false);
    expect(contacts.get("dead@example.com")?.unsubscribed).toBe(true);
  });
});
