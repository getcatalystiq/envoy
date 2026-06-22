import { beforeEach, describe, expect, it, vi } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The MCP tools delegate to the same server fns the host calls. We mock those modules so we can
// assert the delegation (and the suppression-honoring behavior) without a real DB / Resend.
import * as contacts from "@sdk/contacts.js";
import * as cursor from "@sdk/broadcast/cursor.js";
import * as mirrorMod from "@sdk/consent/mirror.js";

import {
  createMcpRouteHandler,
  defaultVerifyMcpToken,
  registerEnvoyTools,
  SERVER_INSTRUCTIONS,
  type McpRouteConfig,
} from "@sdk/route/mcp.js";
import type { Envoy, ResolvedEnvoyConfig } from "@sdk/config.js";
import type { Sequence } from "@sdk/drip/sequence.js";
import type { BroadcastProgram, RunIssueResult } from "@sdk/broadcast/program.js";

vi.mock("@sdk/contacts.js", () => ({
  enroll: vi.fn(),
  deleteContact: vi.fn(),
}));
vi.mock("@sdk/broadcast/cursor.js", () => ({
  read: vi.fn(),
}));
vi.mock("@sdk/consent/mirror.js", () => ({
  createConsentMirror: vi.fn(),
}));

const MCP_SECRET = "mcp-secret-abcdef0123456789";

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

function makeEnvoy(overrides: Partial<ResolvedEnvoyConfig> = {}): Envoy {
  const config = {
    installNamespace: "test",
    resendApiKey: undefined,
    webhookSecret: "whsec_x",
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
    db: { namespace: "test" } as unknown as Envoy["db"],
    resend: { enabled: false, client: () => null } as Envoy["resend"],
    assertNamespaceFingerprint: async () => {},
    // Redact must never echo the raw value — return a fixed sentinel so a leak would fail a test.
    redact: () => "***",
  };
}

function fakeSequence(key: string): Sequence {
  return Object.freeze({
    key,
    steps: Object.freeze([
      Object.freeze({
        templateId: "tmpl_1",
        waitDays: 0,
        aiSlots: Object.freeze(["subject", "body"]),
        brief: "be warm",
      }),
    ]),
  });
}

function fakeProgram(key: string, runIssue: BroadcastProgram["runIssue"]): BroadcastProgram {
  return Object.freeze({
    key,
    segmentId: "seg_news",
    cadenceDays: 7,
    from: "news@example.com",
    topicFor: (s: string) => ({ stream: "digest" as const, subject: s }),
    cursorKey: (s: string) => ({ programKey: key, subjectKey: s }),
    broadcastKey: (s: string, n: number) => `${key}:${s}:${n}`,
    runIssue,
  });
}

/** Connect a real McpServer (with our tools) to an in-memory Client and return both. */
async function connectMcp(config: McpRouteConfig): Promise<{ client: Client; server: McpServer }> {
  const server = new McpServer({ name: "envoy-test", version: "0.0.0" });
  registerEnvoyTools(server, config);
  const client = new Client({ name: "test-client", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const enrollMock = vi.mocked(contacts.enroll);
const deleteMock = vi.mocked(contacts.deleteContact);
const readCursorMock = vi.mocked(cursor.read);
const createMirrorMock = vi.mocked(mirrorMod.createConsentMirror);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------------------------
// Tool registration / listing
// ---------------------------------------------------------------------------------------------

describe("registerEnvoyTools", () => {
  it("registers the single-tenant lifecycle tools", async () => {
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual(
      [
        "delete_contact",
        "enroll_contact",
        "get_consent",
        "get_program",
        "get_program_state",
        "get_sequence",
        "list_programs",
        "list_sequences",
        "run_broadcast_issue",
      ].sort()
    );
  });

  it("exposes single-tenant server instructions with no organization_id surface", () => {
    expect(SERVER_INSTRUCTIONS).toContain("single tenant");
    expect(SERVER_INSTRUCTIONS).not.toMatch(/organization_id|tenantId/);
  });
});

// ---------------------------------------------------------------------------------------------
// enroll_contact — covers R42 happy path (an authed MCP call enrolls a contact)
// ---------------------------------------------------------------------------------------------

describe("enroll_contact tool", () => {
  it("enrolls a contact through the real enroll() server fn", async () => {
    enrollMock.mockResolvedValue({
      email: "a@example.com",
      sequenceKey: "welcome",
      status: "active",
      created: true,
      suppressed: false,
      sync: { ok: true, dirty: false, steps: { contact: "confirmed", segment: "confirmed", topic: "none" } },
    });

    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await client.callTool({
      name: "enroll_contact",
      arguments: { email: "a@example.com", sequenceKey: "welcome" },
    });

    expect(enrollMock).toHaveBeenCalledTimes(1);
    expect(enrollMock).toHaveBeenCalledWith(
      expect.anything(),
      { email: "a@example.com", data: undefined },
      "welcome",
      {}
    );
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as Record<string, unknown>)?.created).toBe(true);
  });

  it("passes a topic (stream + subject) through to enroll()", async () => {
    enrollMock.mockResolvedValue({
      email: "a@example.com",
      sequenceKey: "welcome",
      status: "active",
      created: true,
      suppressed: false,
      sync: null,
    });
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    await client.callTool({
      name: "enroll_contact",
      arguments: {
        email: "a@example.com",
        sequenceKey: "welcome",
        topicStream: "digest",
        topicSubject: "IT",
      },
    });
    expect(enrollMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "welcome",
      { topic: { stream: "digest", subject: "IT" } }
    );
  });

  // Edge (the unit's stated edge): MCP tool writes honor the suppression mirror — a suppressed
  // contact is recorded but the result reports suppressed and nothing is synced/sent.
  it("honors the suppression mirror — a suppressed contact is not re-synced", async () => {
    enrollMock.mockResolvedValue({
      email: "gone@example.com",
      sequenceKey: "welcome",
      status: "active",
      created: true,
      suppressed: true,
      sync: null, // enroll() skips the Resend sync for a suppressed contact
    });
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await client.callTool({
      name: "enroll_contact",
      arguments: { email: "gone@example.com", sequenceKey: "welcome" },
    });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.suppressed).toBe(true);
    expect(structured.syncOk).toBeNull();
    expect((res.content as { text: string }[])[0].text).toContain("suppressed");
  });

  it("returns a redacted error result (never throws, no PII) when enroll() fails", async () => {
    enrollMock.mockRejectedValue(new Error("db down for marko@example.com"));
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await client.callTool({
      name: "enroll_contact",
      arguments: { email: "a@example.com", sequenceKey: "welcome" },
    });
    expect(res.isError).toBe(true);
    const text = (res.content as { text: string }[])[0].text;
    expect(text).toContain("***");
    expect(text).not.toContain("marko@example.com");
  });

  it("rejects a malformed email at the tool input-schema boundary", async () => {
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await client.callTool({
      name: "enroll_contact",
      arguments: { email: "not-an-email", sequenceKey: "welcome" },
    });
    expect(res.isError).toBe(true);
    expect(enrollMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------------------------
// Sequence / program introspection
// ---------------------------------------------------------------------------------------------

describe("sequence + program introspection tools", () => {
  it("list_sequences enumerates a Map registry", async () => {
    const sequences = new Map<string, Sequence>([["welcome", fakeSequence("welcome")]]);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, sequences });
    const res = await client.callTool({ name: "list_sequences", arguments: {} });
    expect((res.structuredContent as { sequences: string[] }).sequences).toEqual(["welcome"]);
  });

  it("list_sequences reports non-enumerable for a function registry", async () => {
    const sequences = (key: string) => (key === "welcome" ? fakeSequence("welcome") : undefined);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, sequences });
    const res = await client.callTool({ name: "list_sequences", arguments: {} });
    expect((res.structuredContent as { enumerable: boolean }).enumerable).toBe(false);
  });

  it("get_sequence returns the steps of a registered sequence", async () => {
    const sequences = new Map<string, Sequence>([["welcome", fakeSequence("welcome")]]);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, sequences });
    const res = await client.callTool({ name: "get_sequence", arguments: { key: "welcome" } });
    const structured = res.structuredContent as { key: string; steps: unknown[] };
    expect(structured.key).toBe("welcome");
    expect(structured.steps).toHaveLength(1);
  });

  it("get_sequence errors on an unregistered key (never invents one)", async () => {
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, sequences: new Map() });
    const res = await client.callTool({ name: "get_sequence", arguments: { key: "nope" } });
    expect(res.isError).toBe(true);
  });

  it("get_program returns a registered program's config", async () => {
    const program = fakeProgram("news", vi.fn());
    const programs = new Map<string, BroadcastProgram>([["news", program]]);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, programs });
    const res = await client.callTool({ name: "get_program", arguments: { key: "news" } });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.segmentId).toBe("seg_news");
    expect(structured.cadenceDays).toBe(7);
  });
});

// ---------------------------------------------------------------------------------------------
// State / consent reads
// ---------------------------------------------------------------------------------------------

describe("get_program_state tool", () => {
  it("reads the cursor state (watermark, issueSeq, lastFiredAt health) for a subject", async () => {
    readCursorMock.mockResolvedValue({
      watermark: "2026-06-20T00:00:00Z",
      issueSeq: 3,
      lastFiredAt: "2026-06-20T00:00:01Z",
      paused: false,
    });
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await client.callTool({
      name: "get_program_state",
      arguments: { programKey: "news", subjectKey: "IT" },
    });
    expect(readCursorMock).toHaveBeenCalledWith(expect.anything(), {
      programKey: "news",
      subjectKey: "IT",
    });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.issueSeq).toBe(3);
    expect(structured.lastFiredAt).toBe("2026-06-20T00:00:01Z");
  });

  it("defaults subjectKey to 'default'", async () => {
    readCursorMock.mockResolvedValue({ watermark: null, issueSeq: 0, lastFiredAt: null, paused: false });
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    await client.callTool({ name: "get_program_state", arguments: { programKey: "news" } });
    expect(readCursorMock).toHaveBeenCalledWith(expect.anything(), {
      programKey: "news",
      subjectKey: "default",
    });
  });
});

describe("get_consent tool", () => {
  it("reports deny-by-default when no consent row exists", async () => {
    createMirrorMock.mockReturnValue({ read: vi.fn().mockResolvedValue(null) } as never);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await client.callTool({
      name: "get_consent",
      arguments: { email: "a@example.com", topicKey: "weekly" },
    });
    expect((res.structuredContent as { found: boolean }).found).toBe(false);
  });

  it("surfaces the per-stream consent statuses (the send gate)", async () => {
    createMirrorMock.mockReturnValue({
      read: vi.fn().mockResolvedValue({
        contact: "test:a@example.com",
        topicKey: "weekly",
        topicId: "topic_1",
        digest: "opt_in",
        alert: "unsubscribed",
        dirty: false,
      }),
    } as never);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await client.callTool({
      name: "get_consent",
      arguments: { email: "a@example.com", topicKey: "weekly" },
    });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.digest).toBe("opt_in");
    expect(structured.alert).toBe("unsubscribed");
  });

  it("constructs the ConsentMirror ONCE at registration, not per get_consent call (P3)", async () => {
    const read = vi.fn().mockResolvedValue(null);
    createMirrorMock.mockReturnValue({ read } as never);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });

    // Registration (inside connectMcp) is the only place the mirror is built.
    expect(createMirrorMock).toHaveBeenCalledTimes(1);

    // Three consent reads must NOT re-instantiate the mirror — they reuse the closed-over one.
    for (let i = 0; i < 3; i += 1) {
      await client.callTool({
        name: "get_consent",
        arguments: { email: `c${i}@example.com`, topicKey: "weekly" },
      });
    }
    expect(createMirrorMock).toHaveBeenCalledTimes(1); // still one — not 1 + 3
    expect(read).toHaveBeenCalledTimes(3); // the single mirror handled all three reads
  });
});

// ---------------------------------------------------------------------------------------------
// run_broadcast_issue — delegates to program.runIssue (reconcile→claim→send→advance ordering)
// ---------------------------------------------------------------------------------------------

describe("run_broadcast_issue tool", () => {
  it("triggers an issue through the program's runIssue (the canonical ordering)", async () => {
    const runIssue = vi.fn<BroadcastProgram["runIssue"]>().mockResolvedValue({
      programKey: "news",
      subjectKey: "default",
      sent: true,
      broadcastId: "bc_1",
    } satisfies RunIssueResult);
    const programs = new Map<string, BroadcastProgram>([["news", fakeProgram("news", runIssue)]]);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, programs });
    const res = await client.callTool({
      name: "run_broadcast_issue",
      arguments: { programKey: "news", subjectKey: "default" },
    });
    expect(runIssue).toHaveBeenCalledTimes(1);
    expect(runIssue).toHaveBeenCalledWith(expect.anything(), { subjectKey: "default" });
    expect((res.structuredContent as Record<string, unknown>).sent).toBe(true);
  });

  it("reports a per-subject fail-soft failure without throwing", async () => {
    const runIssue = vi.fn<BroadcastProgram["runIssue"]>().mockResolvedValue({
      programKey: "news",
      subjectKey: "default",
      sent: false,
      failed: "resend hiccup",
    } satisfies RunIssueResult);
    const programs = new Map<string, BroadcastProgram>([["news", fakeProgram("news", runIssue)]]);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, programs });
    const res = await client.callTool({
      name: "run_broadcast_issue",
      arguments: { programKey: "news" },
    });
    const structured = res.structuredContent as Record<string, unknown>;
    expect(structured.sent).toBe(false);
    expect(structured.failed).toBe("resend hiccup");
  });

  it("forwards `force` to skip the cadence timer (claim still guards the send-once)", async () => {
    const runIssue = vi.fn<BroadcastProgram["runIssue"]>().mockResolvedValue({
      programKey: "news",
      subjectKey: "default",
      sent: true,
      broadcastId: "bc_2",
    } satisfies RunIssueResult);
    const programs = new Map<string, BroadcastProgram>([["news", fakeProgram("news", runIssue)]]);
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, programs });
    await client.callTool({
      name: "run_broadcast_issue",
      arguments: { programKey: "news", force: true },
    });
    expect(runIssue).toHaveBeenCalledWith(expect.anything(), { subjectKey: "default", force: true });
  });

  it("errors on an unregistered program", async () => {
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET, programs: new Map() });
    const res = await client.callTool({ name: "run_broadcast_issue", arguments: { programKey: "ghost" } });
    expect(res.isError).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// delete_contact — right-to-erasure (suppress-before-delete)
// ---------------------------------------------------------------------------------------------

describe("delete_contact tool", () => {
  it("delegates to deleteContact() (suppress-first, fail-soft teardown)", async () => {
    deleteMock.mockResolvedValue({
      email: "gone@example.com",
      suppressed: true,
      resendContactId: null,
      resendContactDeleted: "skipped",
      segmentMembershipRemoved: "skipped",
      topicMembershipCleared: "skipped",
      piiPurged: true,
    });
    const { client } = await connectMcp({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await client.callTool({
      name: "delete_contact",
      arguments: { email: "gone@example.com" },
    });
    expect(deleteMock).toHaveBeenCalledWith(expect.anything(), "gone@example.com");
    expect((res.structuredContent as { suppressed: boolean }).suppressed).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------
// Auth — defaultVerifyMcpToken (the dedicated MCP credential, R42)
// ---------------------------------------------------------------------------------------------

describe("defaultVerifyMcpToken", () => {
  const req = new Request("https://app.example.com/mcp");

  it("accepts the correct token and returns AuthInfo", async () => {
    const verify = defaultVerifyMcpToken(MCP_SECRET);
    const info = await verify(req, MCP_SECRET);
    expect(info).toMatchObject({ token: MCP_SECRET, clientId: "envoy-mcp" });
  });

  it("rejects a wrong token", async () => {
    const verify = defaultVerifyMcpToken(MCP_SECRET);
    expect(await verify(req, "wrong-secret-aaaaaaaaaaaa")).toBeUndefined();
  });

  it("rejects a missing token", async () => {
    const verify = defaultVerifyMcpToken(MCP_SECRET);
    expect(await verify(req, undefined)).toBeUndefined();
    expect(await verify(req, "")).toBeUndefined();
  });

  it("fails closed when the secret is unset (never open, R42)", async () => {
    const verify = defaultVerifyMcpToken(undefined);
    expect(await verify(req, "anything")).toBeUndefined();
    expect(await verify(req, "")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------------------------
// createMcpRouteHandler — the mounted SubHandler (never unauthenticated)
// ---------------------------------------------------------------------------------------------

describe("createMcpRouteHandler", () => {
  it("validates its config", () => {
    expect(() => createMcpRouteHandler(null as never)).toThrow(/config object/);
    expect(() => createMcpRouteHandler({ envoy: null } as never)).toThrow(/envoy/);
  });

  it("returns a web-standard SubHandler", () => {
    const handler = createMcpRouteHandler({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    expect(typeof handler).toBe("function");
  });

  it("rejects an unauthenticated call (no bearer token) — never open", async () => {
    const handler = createMcpRouteHandler({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    // A mounted catch-all path that does NOT exact-match /mcp — the handler must still canonicalize
    // it and the auth layer must reject the missing credential.
    const res = await handler(
      new Request("https://app.example.com/api/envoy/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("rejects a wrong bearer token", async () => {
    const handler = createMcpRouteHandler({ envoy: makeEnvoy(), mcpSecret: MCP_SECRET });
    const res = await handler(
      new Request("https://app.example.com/envoy/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer wrong-secret-aaaaaaaaaaaa",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("fails closed when no mcpSecret and no custom verifyToken is supplied", async () => {
    const handler = createMcpRouteHandler({ envoy: makeEnvoy() });
    const res = await handler(
      new Request("https://app.example.com/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer anything-at-all-123456",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    expect(res.status).toBe(401);
  });

  it("honors a custom verifyToken (host authorize recognizing the agent token)", async () => {
    const verifyToken = vi.fn(async (_req: Request, token?: string) =>
      token === "agent-token"
        ? { token, clientId: "agent", scopes: ["write"] }
        : undefined
    );
    const handler = createMcpRouteHandler({ envoy: makeEnvoy(), verifyToken });
    const res = await handler(
      new Request("https://app.example.com/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer nope" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
      })
    );
    expect(res.status).toBe(401);
    expect(verifyToken).toHaveBeenCalled();
  });
});
