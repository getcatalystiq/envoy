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
        events: { stream: mocks.stream, send: mocks.send, list: mocks.eventsList },
      },
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
  mocks.create.mockResolvedValue({ id: "sess_1" });
});

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

  it("returns the parsed {body} from a completed (idle) session without sending", async () => {
    mocks.retrieve.mockResolvedValue({ id: "sess_9", status: "idle" });
    mocks.eventsList.mockReturnValue(eventList([agentMessage('{"body":"harvested"}')]));
    expect(await harvestAgentSession("sess_9")).toEqual({ body: "harvested" });
    expect(mocks.create).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it("returns null when the session is not idle yet", async () => {
    mocks.retrieve.mockResolvedValue({ id: "sess_9", status: "running" });
    expect(await harvestAgentSession("sess_9")).toBeNull();
  });

  it("returns null when retrieve throws", async () => {
    mocks.retrieve.mockRejectedValue(new Error("gone"));
    expect(await harvestAgentSession("sess_9")).toBeNull();
  });
});

describe("AgentError", () => {
  it("carries status + detail", () => {
    const e = new AgentError("boom", 503, "why");
    expect(e.status).toBe(503);
    expect(e.detail).toBe("why");
  });
});
