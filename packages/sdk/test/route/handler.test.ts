import { describe, expect, it, vi } from "vitest";
import { Webhook } from "svix";

import {
  createEnvoyHandler,
  resolveSubpath,
  type EnvoyHandlerConfig,
  type SubHandler,
} from "@sdk/route/handler.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";

// ---------------------------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------------------------

const CRON_SECRET = "cron-secret-0123456789";
// Svix secrets are base64 after the `whsec_` prefix; use a stable one for sign/verify symmetry.
const WEBHOOK_SECRET = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
const MCP_SECRET = "mcp-secret-abcdef0123456789";

/**
 * A minimal `Envoy` stand-in. U4 only reads `config.cronSecret` + `config.webhookSecret`, so the
 * rest is filled with inert placeholders — no real DB/Resend touched.
 */
function makeEnvoy(overrides: Partial<ResolvedEnvoyConfig> = {}): Envoy {
  const config = {
    installNamespace: "test",
    resendApiKey: undefined,
    webhookSecret: WEBHOOK_SECRET,
    cronSecret: CRON_SECRET,
    unsubscribeSecret: "unsub-secret-0123456789",
    baseSegmentId: "seg_base",
    agent: undefined,
    aiFieldAllowList: Object.freeze([]),
    streams: Object.freeze({}),
    ...overrides,
  } as ResolvedEnvoyConfig;

  return {
    config,
    // U4 never touches these — narrow casts keep the fixture tiny.
    db: {} as Envoy["db"],
    resend: { enabled: false, client: () => null } as Envoy["resend"],
    assertNamespaceFingerprint: async () => {},
    redact: (v: unknown) => String(v),
  };
}

function req(path: string, init?: RequestInit): Request {
  return new Request(`https://app.example.com${path}`, init);
}

function bearer(secret: string): HeadersInit {
  return { authorization: `Bearer ${secret}` };
}

/** A sub-handler that records it was reached and returns 200 with a marker body. */
function marker(name: string): { handler: SubHandler; calls: () => number } {
  let count = 0;
  return {
    handler: () => {
      count += 1;
      return new Response(name, { status: 200 });
    },
    calls: () => count,
  };
}

/** Build a valid Svix-signed webhook request for the happy path. */
function signedWebhook(path: string, body: string, secret = WEBHOOK_SECRET): Request {
  const wh = new Webhook(secret);
  const id = "msg_test_1";
  const ts = Math.floor(Date.now() / 1000);
  const signature = wh.sign(id, new Date(ts * 1000), body);
  return req(path, {
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

// ---------------------------------------------------------------------------------------------
// Factory contract
// ---------------------------------------------------------------------------------------------

describe("createEnvoyHandler factory", () => {
  it("returns App-Router-compatible GET and POST handlers", () => {
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true });
    expect(typeof h.GET).toBe("function");
    expect(typeof h.POST).toBe("function");
  });

  it("throws when no authorize callback is supplied (API surface must not be open, R6)", () => {
    // @ts-expect-error intentionally omitting authorize
    expect(() => createEnvoyHandler({ envoy: makeEnvoy() })).toThrow(/authorize/);
  });

  it("throws when no envoy handle is supplied", () => {
    // @ts-expect-error intentionally omitting envoy
    expect(() => createEnvoyHandler({ authorize: () => true })).toThrow(/envoy/);
  });
});

// ---------------------------------------------------------------------------------------------
// Sub-path resolution (mount-agnostic)
// ---------------------------------------------------------------------------------------------

describe("resolveSubpath", () => {
  it("finds the known sub-path regardless of mount base", () => {
    expect(resolveSubpath("https://x.dev/api/envoy/cron/tick")).toBe("cron");
    expect(resolveSubpath("https://x.dev/envoy/webhook")).toBe("webhook");
    expect(resolveSubpath("https://x.dev/api/api/foo")).toBe("api");
    expect(resolveSubpath("https://x.dev/mcp")).toBe("mcp");
  });

  it("returns null for an unknown sub-path (→ 404)", () => {
    expect(resolveSubpath("https://x.dev/envoy/unknownthing")).toBeNull();
    expect(resolveSubpath("https://x.dev/")).toBeNull();
  });

  it("returns null for a malformed URL", () => {
    expect(resolveSubpath("not a url")).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------
// /api + /read — host authorize (R6)
// ---------------------------------------------------------------------------------------------

describe("/api + /read auth (R6)", () => {
  it("Happy: an API request passing authorize proceeds to the handler", async () => {
    const api = marker("api-body");
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, api: api.handler });
    const res = await h.POST(req("/api/envoy/api/enroll"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("api-body");
    expect(api.calls()).toBe(1);
  });

  it("Happy: failing authorize returns 401 with NO state change (handler never runs)", async () => {
    const api = marker("api-body");
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => false, api: api.handler });
    const res = await h.POST(req("/api/envoy/api/enroll"));
    expect(res.status).toBe(401);
    expect(api.calls()).toBe(0); // no state change
  });

  it("awaits an async authorize", async () => {
    const api = marker("api-body");
    const authorize = vi.fn(async () => true);
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize, api: api.handler });
    const res = await h.GET(req("/api/envoy/api/state"));
    expect(authorize).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(api.calls()).toBe(1);
  });

  it("a thrown authorize fails closed (401), never a 500", async () => {
    const api = marker("api-body");
    const h = createEnvoyHandler({
      envoy: makeEnvoy(),
      authorize: () => {
        throw new Error("auth backend down");
      },
      api: api.handler,
    });
    const res = await h.POST(req("/api/envoy/api/enroll"));
    expect(res.status).toBe(401);
    expect(api.calls()).toBe(0);
  });

  it("passes a non-2xx Response from authorize through verbatim (e.g. 403)", async () => {
    const h = createEnvoyHandler({
      envoy: makeEnvoy(),
      authorize: () => new Response("forbidden", { status: 403 }),
      api: marker("api-body").handler,
    });
    const res = await h.POST(req("/api/envoy/api/enroll"));
    expect(res.status).toBe(403);
    expect(await res.text()).toBe("forbidden");
  });

  it("/read is also gated by authorize", async () => {
    const read = marker("read-body");
    const authorize = vi.fn(() => false);
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize, read: read.handler });
    const res = await h.GET(req("/api/envoy/read/state"));
    expect(res.status).toBe(401);
    expect(read.calls()).toBe(0);
    expect(authorize).toHaveBeenCalledTimes(1);
  });

  it("an authenticated /api with no handler returns 501 (post-auth, not an oracle)", async () => {
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true });
    const res = await h.POST(req("/api/envoy/api/enroll"));
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------------------------
// /cron — CRON_SECRET (R40)
// ---------------------------------------------------------------------------------------------

describe("/cron auth (R40)", () => {
  it("Happy: correct CRON_SECRET proceeds", async () => {
    const cron = marker("cron-body");
    const authorize = vi.fn(() => false); // would deny — proves cron does NOT use authorize
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize, cron: cron.handler });
    const res = await h.POST(req("/api/envoy/cron/tick", { headers: bearer(CRON_SECRET) }));
    expect(res.status).toBe(200);
    expect(cron.calls()).toBe(1);
    expect(authorize).not.toHaveBeenCalled(); // cron bypasses authorize entirely
  });

  it("wrong CRON_SECRET → 401, handler never runs", async () => {
    const cron = marker("cron-body");
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, cron: cron.handler });
    const res = await h.POST(req("/api/envoy/cron/tick", { headers: bearer("wrong-secret-value") }));
    expect(res.status).toBe(401);
    expect(cron.calls()).toBe(0);
  });

  it("absent CRON_SECRET header → 401", async () => {
    const cron = marker("cron-body");
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, cron: cron.handler });
    const res = await h.POST(req("/api/envoy/cron/tick"));
    expect(res.status).toBe(401);
    expect(cron.calls()).toBe(0);
  });

  it("a near-miss secret of different length → 401 (length leak only, no content leak)", async () => {
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, cron: () => new Response() });
    const res = await h.POST(
      req("/api/envoy/cron/tick", { headers: bearer(CRON_SECRET + "extra") })
    );
    expect(res.status).toBe(401);
  });

  it("unset CRON_SECRET fails closed outside dev (unauthenticated send/AI trigger blocked)", async () => {
    const cron = marker("cron-body");
    const h = createEnvoyHandler({
      envoy: makeEnvoy({ cronSecret: "" }),
      authorize: () => true,
      environment: "prod",
      cron: cron.handler,
    });
    const res = await h.POST(req("/api/envoy/cron/tick"));
    expect(res.status).toBe(401);
    expect(cron.calls()).toBe(0);
  });

  it("unset CRON_SECRET is allowed only in dev", async () => {
    const cron = marker("cron-body");
    const h = createEnvoyHandler({
      envoy: makeEnvoy({ cronSecret: "" }),
      authorize: () => true,
      environment: "dev",
      cron: cron.handler,
    });
    const res = await h.POST(req("/api/envoy/cron/tick"));
    expect(res.status).toBe(200);
    expect(cron.calls()).toBe(1);
  });

  it("defaults to fail-closed when environment is omitted (safe by default)", async () => {
    const h = createEnvoyHandler({
      envoy: makeEnvoy({ cronSecret: "" }),
      authorize: () => true,
      cron: () => new Response(),
    });
    const res = await h.POST(req("/api/envoy/cron/tick"));
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------------------------
// /webhook — Svix (R41)
// ---------------------------------------------------------------------------------------------

describe("/webhook auth (R41)", () => {
  it("Happy: a Svix-valid webhook proceeds and hands the verified body downstream", async () => {
    const body = JSON.stringify({ type: "email.delivered", data: { email_id: "e1" } });
    let received: string | null = null;
    const authorize = vi.fn(() => false); // proves webhook bypasses authorize
    const h = createEnvoyHandler({
      envoy: makeEnvoy(),
      authorize,
      webhook: async (request) => {
        received = await request.text();
        return new Response("ingested", { status: 200 });
      },
    });
    const res = await h.POST(signedWebhook("/api/envoy/webhook", body));
    expect(res.status).toBe(200);
    expect(received).toBe(body); // verified raw body re-exposed to the handler
    expect(authorize).not.toHaveBeenCalled();
  });

  it("Error: an unsigned webhook is rejected (401), handler never runs", async () => {
    const webhook = marker("ingest");
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, webhook: webhook.handler });
    const body = JSON.stringify({ type: "email.bounced" });
    const res = await h.POST(req("/api/envoy/webhook", { method: "POST", body }));
    expect(res.status).toBe(401);
    expect(webhook.calls()).toBe(0);
  });

  it("Error: a forged signature (wrong secret) is rejected, writes nothing", async () => {
    const webhook = marker("ingest");
    const forged = signedWebhook(
      "/api/envoy/webhook",
      JSON.stringify({ type: "contact.updated", data: { unsubscribed: true } }),
      "whsec_" + Buffer.from("an-entirely-different-secret-key!").toString("base64")
    );
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, webhook: webhook.handler });
    const res = await h.POST(forged);
    expect(res.status).toBe(401);
    expect(webhook.calls()).toBe(0);
  });

  it("Error: a replayed webhook (stale timestamp) is rejected", async () => {
    const wh = new Webhook(WEBHOOK_SECRET);
    const id = "msg_replay";
    const staleTs = Math.floor(Date.now() / 1000) - 60 * 60; // 1h old — outside Svix tolerance
    const body = JSON.stringify({ type: "email.delivered" });
    const signature = wh.sign(id, new Date(staleTs * 1000), body);
    const stale = req("/api/envoy/webhook", {
      method: "POST",
      headers: {
        "svix-id": id,
        "svix-timestamp": String(staleTs),
        "svix-signature": signature,
      },
      body,
    });
    const webhook = marker("ingest");
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, webhook: webhook.handler });
    const res = await h.POST(stale);
    expect(res.status).toBe(401);
    expect(webhook.calls()).toBe(0);
  });

  it("missing svix headers (partial) are rejected before any body read", async () => {
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, webhook: () => new Response() });
    const res = await h.POST(
      req("/api/envoy/webhook", { method: "POST", headers: { "svix-id": "only-id" }, body: "{}" })
    );
    expect(res.status).toBe(401);
  });

  it("an empty webhook secret fails closed (cannot verify any signature)", async () => {
    const body = JSON.stringify({ type: "email.delivered" });
    // Sign with the real secret, but the handler is configured with no secret → cannot verify.
    const signed = signedWebhook("/api/envoy/webhook", body);
    const h = createEnvoyHandler({
      envoy: makeEnvoy({ webhookSecret: "" }),
      authorize: () => true,
      webhook: () => new Response(),
    });
    const res = await h.POST(signed);
    expect(res.status).toBe(401);
  });

  it("a verified webhook with no handler returns 501 (post-auth)", async () => {
    const body = JSON.stringify({ type: "email.delivered" });
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true });
    const res = await h.POST(signedWebhook("/api/envoy/webhook", body));
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------------------------
// /unsubscribe — self-authenticating signed token (R33), bypasses authorize
// ---------------------------------------------------------------------------------------------

describe("/unsubscribe (R33)", () => {
  it("Edge: does NOT call authorize — delegates to the self-authenticating handler", async () => {
    const authorize = vi.fn(() => false);
    const unsubscribe = marker("unsub-landing");
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize, unsubscribe: unsubscribe.handler });
    const res = await h.GET(req("/api/envoy/unsubscribe?token=abc"));
    expect(res.status).toBe(200);
    expect(unsubscribe.calls()).toBe(1);
    expect(authorize).not.toHaveBeenCalled();
  });

  it("with no handler wired returns 501 (the token gate lives in the handler, U6)", async () => {
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true });
    const res = await h.GET(req("/api/envoy/unsubscribe?token=abc"));
    expect(res.status).toBe(501);
  });
});

// ---------------------------------------------------------------------------------------------
// /mcp — dedicated credential (R42) — never open
// ---------------------------------------------------------------------------------------------

describe("/mcp auth (R42)", () => {
  it("Error: an MCP path with no credential configured → 401 (never open)", async () => {
    const mcp = marker("mcp-body");
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true, mcp: mcp.handler });
    const res = await h.POST(req("/api/envoy/mcp", { headers: bearer(MCP_SECRET) }));
    expect(res.status).toBe(401);
    expect(mcp.calls()).toBe(0);
  });

  it("Error: unauthenticated MCP call (wrong credential) is rejected", async () => {
    const mcp = marker("mcp-body");
    const h = createEnvoyHandler({
      envoy: makeEnvoy(),
      authorize: () => true,
      mcpSecret: MCP_SECRET,
      mcp: mcp.handler,
    });
    const res = await h.POST(req("/api/envoy/mcp", { headers: bearer("wrong-mcp-credential!!") }));
    expect(res.status).toBe(401);
    expect(mcp.calls()).toBe(0);
  });

  it("Error: absent MCP credential → 401", async () => {
    const mcp = marker("mcp-body");
    const h = createEnvoyHandler({
      envoy: makeEnvoy(),
      authorize: () => true,
      mcpSecret: MCP_SECRET,
      mcp: mcp.handler,
    });
    const res = await h.POST(req("/api/envoy/mcp"));
    expect(res.status).toBe(401);
    expect(mcp.calls()).toBe(0);
  });

  it("Happy: correct MCP credential proceeds, bypassing authorize", async () => {
    const mcp = marker("mcp-body");
    const authorize = vi.fn(() => false);
    const h = createEnvoyHandler({
      envoy: makeEnvoy(),
      authorize,
      mcpSecret: MCP_SECRET,
      mcp: mcp.handler,
    });
    const res = await h.POST(req("/api/envoy/mcp", { headers: bearer(MCP_SECRET) }));
    expect(res.status).toBe(200);
    expect(mcp.calls()).toBe(1);
    expect(authorize).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Unknown sub-path + overall "no path is unauthenticated" invariant
// ---------------------------------------------------------------------------------------------

describe("unknown sub-path + global invariant", () => {
  it("a request with no known sub-path segment is a 404", async () => {
    // Mount base contains NO known segment (`/envoy/...`), so a stray action that matches no
    // sub-path resolves to null ⇒ 404. (When the mount base itself contains a known word like
    // `api`, a stray request falls through to that sub-handler, which 404s the unknown action.)
    const h = createEnvoyHandler({ envoy: makeEnvoy(), authorize: () => true });
    const res = await h.POST(req("/envoy/totally-unknown"));
    expect(res.status).toBe(404);
  });

  it("no recognized sub-path reaches its handler without clearing an auth gate", async () => {
    // Every sub-handler is wired and would return 200 if reached. With auth DENIED everywhere
    // (authorize false, no secrets), only /unsubscribe (self-auth) is expected to delegate.
    const handlers = {
      api: marker("api"),
      read: marker("read"),
      cron: marker("cron"),
      webhook: marker("webhook"),
      mcp: marker("mcp"),
    };
    const h = createEnvoyHandler({
      envoy: makeEnvoy({ cronSecret: CRON_SECRET, webhookSecret: WEBHOOK_SECRET }),
      authorize: () => false,
      // mcpSecret deliberately omitted → /mcp closed
      api: handlers.api.handler,
      read: handlers.read.handler,
      cron: handlers.cron.handler,
      webhook: handlers.webhook.handler,
      mcp: handlers.mcp.handler,
    });

    for (const sub of ["api", "read", "cron", "webhook", "mcp"] as const) {
      const res = await h.POST(req(`/api/envoy/${sub}`, { method: "POST", body: "{}" }));
      expect(res.status).toBe(401);
      expect(handlers[sub].calls()).toBe(0);
    }
  });
});
