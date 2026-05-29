import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  TwinError,
  getAgent,
  getInstructions,
  updateInstructions,
  listAgents,
  listRuns,
  getRun,
  startRun,
  cancelRun,
  deleteRun,
  listRunEvents,
  assertRunBelongsToAgent,
  runAgent,
  runAgentJson,
  generateContent,
} from "@/lib/twin";
import { mockFetchQueue } from "../helpers/fetch";

describe("lib/twin", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  describe("twinFetch — auth + URL", () => {
    it("sends x-api-key header and JSON content type", async () => {
      const { calls } = mockFetchQueue([{ body: { agent: { agent_id: "a1" } } }]);
      await getAgent("a1");
      expect(calls[0].url).toBe("https://build.twin.so/v1/agents/a1");
      const headers = calls[0].init.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("test-twin-key");
      expect(headers["Content-Type"]).toBe("application/json");
    });

    it("trims trailing slash from TWIN_API_URL", async () => {
      const original = process.env.TWIN_API_URL;
      process.env.TWIN_API_URL = "https://build.twin.so/";
      // env is cached — clear it
      vi.resetModules();
      const { getAgent: ga } = await import("@/lib/twin");
      const { calls } = mockFetchQueue([{ body: { agent: { agent_id: "a1" } } }]);
      await ga("a1");
      expect(calls[0].url).toBe("https://build.twin.so/v1/agents/a1");
      process.env.TWIN_API_URL = original;
      vi.resetModules();
    });

    it("URL-encodes the agent ID", async () => {
      const { calls } = mockFetchQueue([{ body: { agent: { agent_id: "with space" } } }]);
      await getAgent("with space");
      expect(calls[0].url).toContain("/v1/agents/with%20space");
    });
  });

  describe("twinFetch — error mapping", () => {
    it("throws TwinError with status + detail on Problem Detail response", async () => {
      mockFetchQueue([
        {
          status: 404,
          body: { type: "about:blank", title: "Not Found", status: 404, detail: "Agent missing" },
        },
      ]);
      await expect(getAgent("nope")).rejects.toMatchObject({
        name: "TwinError",
        status: 404,
        message: "Not Found",
        detail: "Agent missing",
      });
    });

    it("falls back to generic message when no Problem Detail body", async () => {
      mockFetchQueue([{ status: 400, body: "" }]);
      await expect(getAgent("x")).rejects.toMatchObject({
        status: 400,
        message: "Twin API error 400",
      });
    });

    it("returns undefined on 204 No Content", async () => {
      mockFetchQueue([{ status: 204 }]);
      await expect(deleteRun("a1", "r1")).resolves.toBeUndefined();
    });
  });

  describe("twinFetch — retry/backoff", () => {
    it("retries on 429 up to 3 times then succeeds", async () => {
      const { calls } = mockFetchQueue([
        { status: 429, body: { title: "Rate limited" } },
        { status: 429, body: { title: "Rate limited" } },
        { status: 200, body: { agent: { agent_id: "a1" } } },
      ]);
      // Use fake timers so backoff doesn't actually sleep
      vi.useFakeTimers();
      const promise = getAgent("a1");
      // Drain all pending timers
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();
      expect(result).toEqual({ agent_id: "a1" });
      expect(calls).toHaveLength(3);
    });

    it("retries on 502/503/504 and 500", async () => {
      for (const status of [500, 502, 503, 504]) {
        const { calls } = mockFetchQueue([
          { status, body: { title: "err" } },
          { status: 200, body: { agent: { agent_id: "a1" } } },
        ]);
        vi.useFakeTimers();
        const p = getAgent("a1");
        await vi.runAllTimersAsync();
        await p;
        vi.useRealTimers();
        expect(calls).toHaveLength(2);
      }
    });

    it("does NOT retry on 400/401/403/404", async () => {
      for (const status of [400, 401, 403, 404]) {
        const { calls } = mockFetchQueue([{ status, body: { title: "err" } }]);
        await expect(getAgent("a1")).rejects.toMatchObject({ status });
        expect(calls).toHaveLength(1);
      }
    });

    it("gives up after MAX_FETCH_RETRIES (3) and throws", async () => {
      const { calls } = mockFetchQueue([
        { status: 503, body: { title: "down" } },
        { status: 503, body: { title: "down" } },
        { status: 503, body: { title: "down" } },
        { status: 503, body: { title: "down" } },
      ]);
      vi.useFakeTimers();
      const p = getAgent("a1");
      const captured: { err?: unknown } = {};
      p.catch((err) => {
        captured.err = err;
      });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      expect(captured.err).toMatchObject({ status: 503 });
      expect(calls).toHaveLength(4); // 1 initial + 3 retries
    });

    it("honors Retry-After header (seconds)", async () => {
      mockFetchQueue([
        { status: 429, headers: { "retry-after": "2" }, body: { title: "err" } },
        { status: 200, body: { agent: { agent_id: "a1" } } },
      ]);
      vi.useFakeTimers();
      const sleepSpy = vi.spyOn(globalThis, "setTimeout");
      const p = getAgent("a1");
      await vi.runAllTimersAsync();
      await p;
      vi.useRealTimers();
      // The retry-after backoff should be ~2000ms (not the default exp).
      // setTimeout is called for the fetch timeout (30000) and the retry sleep — find the retry sleep.
      const retrySleep = sleepSpy.mock.calls.find(([, ms]) => ms === 2000);
      expect(retrySleep).toBeDefined();
    });
  });

  describe("twinFetch — abort + timeout", () => {
    it("runAgent throws TwinError(499) when caller signal is aborted", async () => {
      const controller = new AbortController();
      controller.abort();
      // With existingRunId, runAgent skips startRun and the very first iteration
      // of the poll loop sees signal.aborted and throws 499.
      await expect(
        runAgent("a1", "msg", {
          existingRunId: "r1",
          signal: controller.signal,
          timeoutMs: 60_000,
        }),
      ).rejects.toMatchObject({ name: "TwinError", status: 499 });
    });
  });

  describe("listRuns", () => {
    it("forwards all query params and coerces total_runs to number", async () => {
      const { calls } = mockFetchQueue([
        {
          body: {
            runs: [{ run_id: "r1", agent_id: "a1", run_number: 1, started_at: "", last_event_at: "", event_count: 0, step_count: 0, is_finished: true }],
            total_runs: "5",
            page: 1,
            page_size: 10,
          },
        },
      ]);
      const result = await listRuns("a1", {
        page: 2,
        pageSize: 25,
        filterStatus: "finished",
        filterRunId: "rx",
        filterPolicyGroup: "runner",
      });
      const url = calls[0].url;
      expect(url).toContain("page=2");
      expect(url).toContain("page_size=25");
      expect(url).toContain("filter_status=finished");
      expect(url).toContain("filter_run_id=rx");
      expect(url).toContain("filter_policy_group=runner");
      expect(result.total_runs).toBe(5); // string -> number
    });

    it("handles missing total_runs by defaulting to 0", async () => {
      mockFetchQueue([{ body: { runs: [], total_runs: null, page: 1, page_size: 10 } }]);
      const result = await listRuns("a1");
      expect(result.total_runs).toBe(0);
    });
  });

  describe("getRun", () => {
    it("returns first run from filterRunId list", async () => {
      mockFetchQueue([{ body: { runs: [{ run_id: "r1", is_finished: true }], total_runs: 1, page: 1, page_size: 1 } }]);
      const run = await getRun("a1", "r1");
      expect(run?.run_id).toBe("r1");
    });

    it("returns null when no run matches", async () => {
      mockFetchQueue([{ body: { runs: [], total_runs: 0, page: 1, page_size: 1 } }]);
      expect(await getRun("a1", "nope")).toBeNull();
    });
  });

  describe("assertRunBelongsToAgent", () => {
    it("throws TwinError(404) when run not found", async () => {
      mockFetchQueue([{ body: { runs: [], total_runs: 0, page: 1, page_size: 1 } }]);
      await expect(assertRunBelongsToAgent("a1", "r-rogue")).rejects.toMatchObject({
        name: "TwinError",
        status: 404,
      });
    });

    it("resolves silently when run found", async () => {
      mockFetchQueue([{ body: { runs: [{ run_id: "r1", is_finished: true }], total_runs: 1, page: 1, page_size: 1 } }]);
      await expect(assertRunBelongsToAgent("a1", "r1")).resolves.toBeUndefined();
    });
  });

  describe("startRun / cancelRun / deleteRun", () => {
    it("startRun POSTs body and returns run", async () => {
      const { calls } = mockFetchQueue([
        { body: { run: { run_id: "r1", agent_id: "a1", is_finished: false, run_number: 1, started_at: "", last_event_at: "", event_count: 0, step_count: 0 } } },
      ]);
      await startRun("a1", { runMode: "run", userMessage: "hi" });
      expect(calls[0].init.method).toBe("POST");
      const body = JSON.parse(calls[0].init.body as string);
      expect(body).toEqual({ run_mode: "run", user_message: "hi" });
    });

    it("cancelRun POSTs reason when provided", async () => {
      const { calls } = mockFetchQueue([{ body: { success: true } }]);
      await cancelRun("a1", "r1", "user requested");
      const body = JSON.parse(calls[0].init.body as string);
      expect(body).toEqual({ reason: "user requested" });
    });

    it("cancelRun sends empty object when reason omitted", async () => {
      const { calls } = mockFetchQueue([{ body: { success: true } }]);
      await cancelRun("a1", "r1");
      expect(calls[0].init.body).toBe("{}");
    });

    it("deleteRun DELETEs the run", async () => {
      const { calls } = mockFetchQueue([{ status: 204 }]);
      await deleteRun("a1", "r1");
      expect(calls[0].init.method).toBe("DELETE");
    });
  });

  describe("instructions", () => {
    it("getInstructions returns instructions object or null", async () => {
      mockFetchQueue([{ body: { instructions: { content: "do the thing" } } }]);
      expect(await getInstructions("a1")).toEqual({ content: "do the thing" });
    });

    it("updateInstructions PUTs content + source_type", async () => {
      const { calls } = mockFetchQueue([{ body: { success: true } }]);
      await updateInstructions("a1", "new instructions");
      expect(calls[0].init.method).toBe("PUT");
      const body = JSON.parse(calls[0].init.body as string);
      expect(body).toEqual({ content: "new instructions", source_type: "api" });
    });
  });

  describe("listAgents", () => {
    it("forwards workspace_id, cursor, limit", async () => {
      const { calls } = mockFetchQueue([{ body: { agents: [] } }]);
      await listAgents({ workspaceId: "w1", cursor: "c1", limit: 25 });
      const url = calls[0].url;
      expect(url).toContain("workspace_id=w1");
      expect(url).toContain("cursor=c1");
      expect(url).toContain("limit=25");
    });
  });

  describe("listRunEvents", () => {
    it("forwards limit + after_index", async () => {
      const { calls } = mockFetchQueue([{ body: { events: [], total_count: 0 } }]);
      await listRunEvents("a1", "r1", { limit: 50, afterIndex: 10 });
      expect(calls[0].url).toContain("limit=50");
      expect(calls[0].url).toContain("after_index=10");
    });
  });

  describe("runAgent — happy path", () => {
    it("startRun, polls events, finds terminal event, returns final output", async () => {
      mockFetchQueue([
        // startRun
        { body: { run: { run_id: "r1", agent_id: "a1", is_finished: false, run_number: 1, started_at: "2026-01-01", last_event_at: "2026-01-01", event_count: 0, step_count: 0 } } },
        // first listRunEvents — returns one in-progress event
        { body: { events: [{ event_index: 1, recorded_at: "t1", event: { started: {} } }], total_count: 1 } },
        // second listRunEvents — terminal event with message
        { body: { events: [{ event_index: 2, recorded_at: "t2", event: { completed: {}, message: { text: "Hello world" } } }], total_count: 2 } },
        // final getRun reconciliation
        { body: { runs: [{ run_id: "r1", agent_id: "a1", is_finished: true, status: "finished", run_number: 1, started_at: "2026-01-01", last_event_at: "2026-01-01", event_count: 2, step_count: 1 }], total_runs: 1, page: 1, page_size: 1 } },
      ]);

      vi.useFakeTimers();
      const promise = runAgent("a1", "test message", { timeoutMs: 60_000 });
      await vi.runAllTimersAsync();
      const result = await promise;
      vi.useRealTimers();

      expect(result.runId).toBe("r1");
      expect(result.status).toBe("finished");
      expect(result.output).toBe("Hello world");
    });
  });

  describe("runAgent — existingRunId resume", () => {
    it("does NOT call startRun when existingRunId provided", async () => {
      const { calls } = mockFetchQueue([
        // first listRunEvents — already terminal
        { body: { events: [{ event_index: 1, recorded_at: "t1", event: { completed: {}, message: { text: "Done" } } }], total_count: 1 } },
        // final reconcile
        { body: { runs: [{ run_id: "r-existing", agent_id: "a1", is_finished: true, status: "finished", run_number: 1, started_at: "", last_event_at: "", event_count: 1, step_count: 1 }], total_runs: 1, page: 1, page_size: 1 } },
      ]);
      vi.useFakeTimers();
      const p = runAgent("a1", "msg", { existingRunId: "r-existing", timeoutMs: 60_000 });
      await vi.runAllTimersAsync();
      const result = await p;
      vi.useRealTimers();
      expect(result.runId).toBe("r-existing");
      // No POST to /runs (startRun) should have happened
      const postRuns = calls.find((c) => c.init.method === "POST" && c.url.endsWith("/runs"));
      expect(postRuns).toBeUndefined();
    });

    it("does NOT call cancelRun on error when existingRunId is set", async () => {
      const { calls } = mockFetchQueue([
        // listRunEvents throws via 404
        { status: 404, body: { title: "not found" } },
        { status: 404, body: { title: "not found" } },
        { status: 404, body: { title: "not found" } },
      ]);
      vi.useFakeTimers();
      const p = runAgent("a1", "msg", { existingRunId: "r-x", timeoutMs: 60_000 });
      // Attach catch handler before draining timers to avoid unhandled-rejection warning
      const captured: { err?: unknown } = {};
      p.catch((err) => {
        captured.err = err;
      });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      expect(captured.err).toBeDefined();
      const cancelCall = calls.find((c) => c.url.includes("/cancel"));
      expect(cancelCall).toBeUndefined();
    });
  });

  describe("runAgent — abort calls cancelRun", () => {
    it("when fresh run aborted, cancelRun is called best-effort", async () => {
      const controller = new AbortController();
      const { calls } = mockFetchQueue([
        // startRun
        { body: { run: { run_id: "r1", agent_id: "a1", is_finished: false, run_number: 1, started_at: "", last_event_at: "", event_count: 0, step_count: 0 } } },
        // cancelRun (best-effort)
        { body: { success: true } },
      ]);
      // Abort before polling starts
      controller.abort();
      await expect(runAgent("a1", "msg", { signal: controller.signal, timeoutMs: 1000 })).rejects.toMatchObject({
        name: "TwinError",
        status: 499,
      });
      const cancelCall = calls.find((c) => c.url.includes("/cancel"));
      expect(cancelCall).toBeDefined();
    });
  });

  describe("runAgent — poll error tolerance", () => {
    it("tolerates up to 2 consecutive poll errors, fails on 3rd", async () => {
      mockFetchQueue([
        // startRun
        { body: { run: { run_id: "r1", agent_id: "a1", is_finished: false, run_number: 1, started_at: "", last_event_at: "", event_count: 0, step_count: 0 } } },
        // 3 consecutive 400s on listRunEvents (not retryable inside twinFetch)
        { status: 400, body: { title: "bad" } },
        { status: 400, body: { title: "bad" } },
        { status: 400, body: { title: "bad" } },
        // cancelRun
        { body: { success: true } },
      ]);
      vi.useFakeTimers();
      const p = runAgent("a1", "msg", { timeoutMs: 60_000 });
      const captured: { err?: unknown } = {};
      p.catch((err) => {
        captured.err = err;
      });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      expect(captured.err).toBeDefined();
    });
  });

  describe("runAgentJson — JSON parsing", () => {
    function mockSingleEvent(text: string) {
      return [
        // startRun
        { body: { run: { run_id: "r1", agent_id: "a1", is_finished: false, run_number: 1, started_at: "", last_event_at: "", event_count: 0, step_count: 0 } } },
        // terminal event with the text
        { body: { events: [{ event_index: 1, recorded_at: "t", event: { completed: {}, message: { text } } }], total_count: 1 } },
        // final reconcile
        { body: { runs: [{ run_id: "r1", agent_id: "a1", is_finished: true, status: "finished", run_number: 1, started_at: "", last_event_at: "", event_count: 1, step_count: 1 }], total_runs: 1, page: 1, page_size: 1 } },
      ];
    }

    it("parses plain JSON object", async () => {
      mockFetchQueue(mockSingleEvent(JSON.stringify({ subject: "S", body: "B" })));
      vi.useFakeTimers();
      const p = runAgentJson("a1", "msg");
      await vi.runAllTimersAsync();
      expect(await p).toEqual({ subject: "S", body: "B" });
      vi.useRealTimers();
    });

    it("parses fenced ```json``` block", async () => {
      mockFetchQueue(mockSingleEvent('Sure! Here:\n```json\n{"subject":"S","body":"B"}\n```\nDone.'));
      vi.useFakeTimers();
      const p = runAgentJson("a1", "msg");
      await vi.runAllTimersAsync();
      expect(await p).toEqual({ subject: "S", body: "B" });
      vi.useRealTimers();
    });

    it("throws TwinError on empty output (502)", async () => {
      mockFetchQueue([
        { body: { run: { run_id: "r1", agent_id: "a1", is_finished: false, run_number: 1, started_at: "", last_event_at: "", event_count: 0, step_count: 0 } } },
        { body: { events: [{ event_index: 1, recorded_at: "t", event: { completed: {} } }], total_count: 1 } },
        { body: { runs: [{ run_id: "r1", agent_id: "a1", is_finished: true, status: "finished", run_number: 1, started_at: "", last_event_at: "", event_count: 1, step_count: 1 }], total_runs: 1, page: 1, page_size: 1 } },
      ]);
      vi.useFakeTimers();
      const p = runAgentJson("a1", "msg");
      const captured: { err?: unknown } = {};
      p.catch((err) => {
        captured.err = err;
      });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      expect(captured.err).toMatchObject({ name: "TwinError", status: 502 });
    });

    it("throws TwinError on malformed JSON output (502)", async () => {
      mockFetchQueue(mockSingleEvent("this is just prose, no json"));
      vi.useFakeTimers();
      const p = runAgentJson("a1", "msg");
      const captured: { err?: unknown } = {};
      p.catch((err) => {
        captured.err = err;
      });
      await vi.runAllTimersAsync();
      vi.useRealTimers();
      expect(captured.err).toMatchObject({ name: "TwinError", status: 502 });
    });

    it("wraps non-object JSON (string, array, number) as { raw }", async () => {
      mockFetchQueue(mockSingleEvent('"just a string"'));
      vi.useFakeTimers();
      const p = runAgentJson("a1", "msg");
      await vi.runAllTimersAsync();
      const result = await p;
      vi.useRealTimers();
      expect(result.raw).toBeDefined();
    });
  });

  describe("generateContent", () => {
    it("includes content type and target JSON in prompt", async () => {
      const { calls } = mockFetchQueue([
        { body: { run: { run_id: "r1", agent_id: "a1", is_finished: false, run_number: 1, started_at: "", last_event_at: "", event_count: 0, step_count: 0 } } },
        { body: { events: [{ event_index: 1, recorded_at: "t", event: { completed: {}, message: { text: '{"subject":"S","body":"B"}' } } }], total_count: 1 } },
        { body: { runs: [{ run_id: "r1", agent_id: "a1", is_finished: true, status: "finished", run_number: 1, started_at: "", last_event_at: "", event_count: 1, step_count: 1 }], total_runs: 1, page: 1, page_size: 1 } },
      ]);
      vi.useFakeTimers();
      const p = generateContent("a1", { email: "x@y.com", first_name: "X" }, "educational");
      await vi.runAllTimersAsync();
      await p;
      vi.useRealTimers();
      const startCall = calls[0];
      const body = JSON.parse(startCall.init.body as string);
      expect(body.user_message).toContain("educational");
      expect(body.user_message).toContain("x@y.com");
      expect(body.user_message).toContain('"subject"');
    });
  });

  describe("TwinError class", () => {
    it("preserves status, detail, message, name", () => {
      const err = new TwinError("Bad", 400, "missing field");
      expect(err.name).toBe("TwinError");
      expect(err.message).toBe("Bad");
      expect(err.status).toBe(400);
      expect(err.detail).toBe("missing field");
      expect(err instanceof Error).toBe(true);
    });
  });
});
