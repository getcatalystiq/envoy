import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the Anthropic SDK. The session client narrows on the `type`
// discriminator and reads a few fields loosely, so the fake stream just needs
// to yield scripted events and expose a `controller.abort()`.
const mocks = vi.hoisted(() => {
  class FakeAPIError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = "APIError";
      this.status = status;
    }
  }
  return {
    create: vi.fn(),
    archive: vi.fn(),
    stream: vi.fn(),
    send: vi.fn(),
    retrieve: vi.fn(),
    eventsList: vi.fn(),
    sessionsList: vi.fn(),
    agentsRetrieve: vi.fn(),
    agentsUpdate: vi.fn(),
    FakeAPIError,
  };
});

vi.mock("@anthropic-ai/sdk", () => {
  class Anthropic {
    beta = {
      sessions: {
        create: mocks.create,
        archive: mocks.archive,
        retrieve: mocks.retrieve,
        list: mocks.sessionsList,
        events: { stream: mocks.stream, send: mocks.send, list: mocks.eventsList },
      },
      agents: { retrieve: mocks.agentsRetrieve, update: mocks.agentsUpdate },
    };
    static APIError = mocks.FakeAPIError;
    constructor(_opts?: unknown) {}
  }
  return { default: Anthropic };
});

import {
  runAgentJson,
  runAgentSession,
  harvestAgentSession,
  listAgentSessions,
  getAgentSessionEvents,
  getAgentInstructions,
  updateAgentInstructions,
  AgentError,
} from "@/lib/agent-session";

const AGENT = "agent_1";
const ENV = "env_1";
const GOAL = '{"mode":"personalize"}';

function agentMessage(text: string) {
  return {
    type: "agent.message",
    content: [{ type: "text", text }],
  };
}
const IDLE = { type: "session.status_idle" };

/** A stream that yields the scripted events then ends. */
function scriptedStream(events: unknown[]) {
  return {
    controller: { abort: vi.fn() },
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
  };
}

/** A stream that never ends until its abort signal fires (timeout simulation). */
function hangingStream(signal: AbortSignal) {
  return {
    controller: { abort: vi.fn() },
    [Symbol.asyncIterator]() {
      return {
        next() {
          return new Promise((_resolve, reject) => {
            const fail = () => {
              const e = new Error("aborted");
              e.name = "AbortError";
              reject(e);
            };
            if (signal.aborted) return fail();
            signal.addEventListener("abort", fail, { once: true });
          });
        },
      };
    },
  };
}

beforeEach(() => {
  mocks.create.mockReset();
  mocks.archive.mockReset().mockResolvedValue(undefined);
  mocks.stream.mockReset();
  mocks.send.mockReset().mockResolvedValue(undefined);
  mocks.retrieve.mockReset();
  mocks.eventsList.mockReset();
  mocks.sessionsList.mockReset();
  mocks.agentsRetrieve.mockReset();
  mocks.agentsUpdate.mockReset().mockResolvedValue(undefined);
  mocks.create.mockResolvedValue({ id: "sess_1" });
});

function asyncList(items: unknown[]) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const i of items) yield i;
    },
  };
}

describe("runAgentSession / runAgentJson", () => {
  it("happy path: returns {body}; opens stream before send; sends exact goal text", async () => {
    mocks.stream.mockResolvedValue(scriptedStream([agentMessage('{"body":"X"}'), IDLE]));

    const out = await runAgentJson(AGENT, ENV, GOAL);

    expect(out).toEqual({ body: "X" });
    // create used the {type:'agent',id} object + environment_id
    expect(mocks.create).toHaveBeenCalledWith({
      agent: { type: "agent", id: AGENT },
      environment_id: ENV,
    });
    // stream opened BEFORE send
    expect(mocks.stream.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0],
    );
    // user.message carried the exact goal text
    expect(mocks.send).toHaveBeenCalledWith("sess_1", {
      events: [
        { type: "user.message", content: [{ type: "text", text: GOAL }] },
      ],
    });
  });

  it("passes vault_ids to sessions.create when provided, omits them when empty", async () => {
    mocks.stream.mockResolvedValue(scriptedStream([agentMessage('{"body":"X"}'), IDLE]));
    await runAgentJson(AGENT, ENV, GOAL, { vaultIds: ["vault_1"] });
    expect(mocks.create).toHaveBeenCalledWith({
      agent: { type: "agent", id: AGENT },
      environment_id: ENV,
      vault_ids: ["vault_1"],
    });

    mocks.create.mockClear();
    mocks.stream.mockResolvedValue(scriptedStream([agentMessage('{"body":"X"}'), IDLE]));
    await runAgentJson(AGENT, ENV, GOAL, { vaultIds: [] });
    expect(mocks.create).toHaveBeenCalledWith({
      agent: { type: "agent", id: AGENT },
      environment_id: ENV,
    });
  });

  it("parses {subject, body} object output", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([agentMessage('{"subject":"Hi","body":"Y"}'), IDLE]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ subject: "Hi", body: "Y" });
  });

  it("parses fenced ```json``` output", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([agentMessage('```json\n{"body":"Z"}\n```'), IDLE]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ body: "Z" });
  });

  it("wraps non-object JSON as { raw }", async () => {
    mocks.stream.mockResolvedValue(scriptedStream([agentMessage('"just a string"'), IDLE]));
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ raw: '"just a string"' });
  });

  it("parses a plain ``` fence with no json tag", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([agentMessage('```\n{"body":"plain"}\n```'), IDLE]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ body: "plain" });
  });

  it("salvages a JSON object embedded in surrounding prose", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([
        agentMessage('Here is the personalized copy:\n{"body":"hi {name}"}\nLet me know!'),
        IDLE,
      ]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ body: "hi {name}" });
  });

  it("does not unbalance on braces inside string values", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([agentMessage('prefix {"body":"a } b { c"} suffix'), IDLE]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ body: "a } b { c" });
  });

  it("throws AgentError 502 with the bad output as detail on true parse failure", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([agentMessage("Sorry, I could not complete that."), IDLE]),
    );
    await expect(runAgentJson(AGENT, ENV, GOAL)).rejects.toMatchObject({
      name: "AgentError",
      status: 502,
      detail: "Sorry, I could not complete that.",
    });
  });

  it("throws AgentError 502 on empty output (idle, no agent.message)", async () => {
    mocks.stream.mockResolvedValue(scriptedStream([IDLE]));
    await expect(runAgentJson(AGENT, ENV, GOAL)).rejects.toMatchObject({
      name: "AgentError",
      status: 502,
    });
  });

  it("throws AgentError 502 with the message on session.error", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([{ type: "session.error", error: { message: "model overloaded" } }]),
    );
    await expect(runAgentSession(AGENT, ENV, GOAL)).rejects.toMatchObject({
      status: 502,
      detail: "model overloaded",
    });
    expect(mocks.archive).toHaveBeenCalledWith("sess_1");
  });

  it("content-seek: returns the JSON message, not earlier reasoning", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([
        agentMessage("Let me think about this prospect..."),
        agentMessage('{"body":"final"}'),
        IDLE,
      ]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ body: "final" });
  });

  it("content-seek: ignores trailing commentary after the JSON", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([
        agentMessage('{"body":"answer"}'),
        agentMessage("Hope this helps!"),
        IDLE,
      ]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ body: "answer" });
  });

  it("content-seek: finds the JSON when a tool-use is the final turn before idle", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([
        agentMessage('{"body":"answer"}'),
        { type: "agent.tool_use", name: "web_search" },
        IDLE,
      ]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ body: "answer" });
  });

  it("times out -> AgentError 504 and archives the session", async () => {
    vi.useFakeTimers();
    mocks.stream.mockImplementation((_id, _p, opts) =>
      Promise.resolve(hangingStream((opts as { signal: AbortSignal }).signal)),
    );

    const p = runAgentSession(AGENT, ENV, GOAL, { timeoutMs: 1000 });
    const assertion = expect(p).rejects.toMatchObject({ status: 504 });
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(mocks.archive).toHaveBeenCalledWith("sess_1");
    vi.useRealTimers();
  });

  it("maps an upstream 401 from sessions.create to 502 (not surfaced as 401)", async () => {
    mocks.create.mockRejectedValue(new mocks.FakeAPIError(401, "unauthorized"));
    await expect(runAgentSession(AGENT, ENV, GOAL)).rejects.toMatchObject({
      name: "AgentError",
      status: 502,
    });
  });

  it("idle with stop_reason=requires_action throws 502 (no partial output emitted)", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([
        agentMessage('{"body":"half'),
        { type: "session.status_idle", stop_reason: { type: "requires_action" } },
      ]),
    );
    await expect(runAgentJson(AGENT, ENV, GOAL)).rejects.toMatchObject({ status: 502 });
  });

  it("idle with stop_reason=retries_exhausted throws 502", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([
        agentMessage('{"body":"x"}'),
        { type: "session.status_idle", stop_reason: { type: "retries_exhausted" } },
      ]),
    );
    await expect(runAgentJson(AGENT, ENV, GOAL)).rejects.toMatchObject({ status: 502 });
  });

  it("session.error with retry_status=retrying is NOT terminal — keeps reading to a successful idle", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([
        { type: "session.error", error: { retry_status: { type: "retrying" }, message: "transient" } },
        agentMessage('{"body":"recovered"}'),
        { type: "session.status_idle", stop_reason: { type: "end_turn" } },
      ]),
    );
    expect(await runAgentJson(AGENT, ENV, GOAL)).toEqual({ body: "recovered" });
  });

  it("session.error with retry_status=terminal throws 502", async () => {
    mocks.stream.mockResolvedValue(
      scriptedStream([
        { type: "session.error", error: { retry_status: { type: "terminal" }, message: "model gone" } },
      ]),
    );
    await expect(runAgentSession(AGENT, ENV, GOAL)).rejects.toMatchObject({
      status: 502,
      detail: "model gone",
    });
  });

  // Note: 429 / transient-5xx retry is handled natively by the SDK's
  // `maxRetries` (the equivalent of the old twinFetch 429 backoff), so it is
  // exercised inside the SDK rather than re-tested here.
});

describe("crash-resume marker (onSessionCreated)", () => {
  it("persists the session id AFTER create and BEFORE the billed send", async () => {
    mocks.stream.mockResolvedValue(scriptedStream([agentMessage('{"body":"X"}'), IDLE]));
    const persisted = vi.fn();
    await runAgentSession(AGENT, ENV, GOAL, {
      onSessionCreated: (id) => persisted(id),
    });
    expect(persisted).toHaveBeenCalledWith("sess_1");
    expect(mocks.create.mock.invocationCallOrder[0]).toBeLessThan(
      persisted.mock.invocationCallOrder[0],
    );
    expect(persisted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.send.mock.invocationCallOrder[0],
    );
  });

  it("archives the unsent session and fails if the persist throws (never starts a billed turn)", async () => {
    mocks.stream.mockResolvedValue(scriptedStream([agentMessage('{"body":"X"}'), IDLE]));
    await expect(
      runAgentSession(AGENT, ENV, GOAL, {
        onSessionCreated: () => {
          throw new Error("db down");
        },
      }),
    ).rejects.toMatchObject({ name: "AgentError" });
    expect(mocks.send).not.toHaveBeenCalled();
    expect(mocks.archive).toHaveBeenCalledWith("sess_1");
  });
});

describe("harvestAgentSession", () => {
  function eventList(events: unknown[]) {
    return {
      async *[Symbol.asyncIterator]() {
        for (const e of events) yield e;
      },
    };
  }

  it("completed: parses {body} from an idle session without sending", async () => {
    mocks.retrieve.mockResolvedValue({ id: "sess_9", status: "idle" });
    mocks.eventsList.mockReturnValue(eventList([agentMessage('{"body":"harvested"}')]));
    expect(await harvestAgentSession("sess_9")).toEqual({
      state: "completed",
      output: { body: "harvested" },
    });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("running: returns {state:'running'} when the session is still in progress (so the caller defers, not double-bills)", async () => {
    mocks.retrieve.mockResolvedValue({ id: "sess_9", status: "running" });
    expect(await harvestAgentSession("sess_9")).toEqual({ state: "running" });
  });

  it("unavailable: a terminated session is not usable", async () => {
    mocks.retrieve.mockResolvedValue({ id: "sess_9", status: "terminated" });
    expect(await harvestAgentSession("sess_9")).toEqual({ state: "unavailable" });
  });

  it("unavailable: an idle session that ended on requires_action is rejected (partial output not used)", async () => {
    mocks.retrieve.mockResolvedValue({ id: "sess_9", status: "idle" });
    mocks.eventsList.mockReturnValue(
      eventList([
        agentMessage('{"body":"half'),
        { type: "session.status_idle", stop_reason: { type: "requires_action" } },
      ]),
    );
    expect(await harvestAgentSession("sess_9")).toEqual({ state: "unavailable" });
  });

  it("unavailable: retrieve throwing yields unavailable (caller runs fresh)", async () => {
    mocks.retrieve.mockRejectedValue(new Error("gone"));
    expect(await harvestAgentSession("sess_9")).toEqual({ state: "unavailable" });
  });
});

describe("listAgentSessions", () => {
  it("maps sessions to summaries scoped by agent_id (newest-first from the API)", async () => {
    mocks.sessionsList.mockReturnValue(
      asyncList([
        { id: "s2", status: "idle", created_at: "2026-06-01T02:00:00Z", usage: { x: 1 } },
        { id: "s1", status: "terminated", created_at: "2026-06-01T01:00:00Z" },
      ]),
    );
    const out = await listAgentSessions(AGENT, { limit: 10 });
    expect(mocks.sessionsList).toHaveBeenCalledWith({ agent_id: AGENT });
    expect(out).toEqual([
      { id: "s2", status: "idle", created_at: "2026-06-01T02:00:00Z", usage: { x: 1 } },
      { id: "s1", status: "terminated", created_at: "2026-06-01T01:00:00Z", usage: undefined },
    ]);
  });
});

describe("getAgentSessionEvents — IDOR guard", () => {
  it("returns events when the session belongs to the org's agent", async () => {
    mocks.retrieve.mockResolvedValue({ id: "s1", agent: { id: AGENT } });
    mocks.eventsList.mockReturnValue(asyncList([{ type: "agent.message" }]));
    const events = await getAgentSessionEvents(AGENT, "s1");
    expect(events).toHaveLength(1);
  });

  it("throws 404 (fail closed) when the session belongs to a DIFFERENT agent", async () => {
    mocks.retrieve.mockResolvedValue({ id: "s1", agent: { id: "other_agent" } });
    await expect(getAgentSessionEvents(AGENT, "s1")).rejects.toMatchObject({ status: 404 });
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("throws 404 (fail closed) when the owning-agent field is missing", async () => {
    mocks.retrieve.mockResolvedValue({ id: "s1" });
    await expect(getAgentSessionEvents(AGENT, "s1")).rejects.toMatchObject({ status: 404 });
    expect(mocks.eventsList).not.toHaveBeenCalled();
  });

  it("throws 404 when retrieve itself fails", async () => {
    mocks.retrieve.mockRejectedValue(new Error("nope"));
    await expect(getAgentSessionEvents(AGENT, "s1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("agent instructions", () => {
  it("reads the agent system prompt", async () => {
    mocks.agentsRetrieve.mockResolvedValue({ id: AGENT, system: "Be helpful." });
    expect(await getAgentInstructions(AGENT)).toBe("Be helpful.");
  });

  it("writes the agent system prompt via agents.update (with current version)", async () => {
    mocks.agentsRetrieve.mockResolvedValue({ id: AGENT, version: 3, system: "old" });
    await updateAgentInstructions(AGENT, "New prompt");
    expect(mocks.agentsUpdate).toHaveBeenCalledWith(AGENT, {
      version: 3,
      system: "New prompt",
    });
  });
});

describe("AgentError", () => {
  it("carries status + detail", () => {
    const e = new AgentError("boom", 503, "why");
    expect(e.status).toBe(503);
    expect(e.detail).toBe("why");
  });
});
