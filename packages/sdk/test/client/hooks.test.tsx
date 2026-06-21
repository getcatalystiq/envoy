// @vitest-environment jsdom

// U17 — read-only React hooks. These tests run in jsdom (per-file env above) and exercise the
// hooks through `@testing-library/react`'s `renderHook`, mocking `globalThis.fetch` with a queue so
// no real network is touched. The hooks live in the `./client` entry (the "use client" bundle).

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor, act } from "@testing-library/react";

import {
  useProgramState,
  useConsent,
  useBroadcastHistory,
  useAnalytics,
  __clearReadCache,
  type ProgramStateResponse,
  type ConsentResponse,
  type BroadcastHistoryResponse,
  type AnalyticsResponse,
} from "@sdk/client/index.js";

// --- fetch harness ---------------------------------------------------------------------------

interface CannedResponse {
  status?: number;
  json?: unknown;
  text?: string;
  /** Throw a transport error instead of responding. */
  throwError?: Error;
}

interface RecordedCall {
  url: string;
  init: RequestInit | undefined;
}

let queue: CannedResponse[] = [];
let calls: RecordedCall[] = [];

function makeResponse(canned: CannedResponse): Response {
  const status = canned.status ?? 200;
  const ok = status >= 200 && status < 300;
  const bodyText =
    canned.text !== undefined
      ? canned.text
      : canned.json !== undefined
        ? JSON.stringify(canned.json)
        : "";
  return {
    ok,
    status,
    async json() {
      if (canned.json === undefined) throw new Error("no json");
      return canned.json;
    },
    async text() {
      return bodyText;
    },
  } as unknown as Response;
}

function installFetch(): void {
  globalThis.fetch = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input);
    calls.push({ url, init });
    const canned = queue.shift();
    if (!canned) throw new Error(`unexpected fetch: ${url}`);
    if (canned.throwError) throw canned.throwError;
    return makeResponse(canned);
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  queue = [];
  calls = [];
  __clearReadCache();
  installFetch();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- useProgramState -------------------------------------------------------------------------

describe("useProgramState", () => {
  it("happy: fetches and returns program cursor state for a subject (R4)", async () => {
    const state: ProgramStateResponse = {
      watermark: "2026-06-20T00:00:00Z",
      issueSeq: 3,
      lastFiredAt: "2026-06-20T01:00:00Z",
      paused: false,
    };
    queue.push({ json: state });

    const { result } = renderHook(() =>
      useProgramState({ basePath: "/api/envoy", programKey: "weekly", subjectKey: "default" })
    );

    // Loading is true on the first render (a request is in flight).
    expect(result.current.loading).toBe(true);
    expect(result.current.data).toBeNull();

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toEqual(state);
    expect(result.current.error).toBeNull();

    // Hit the right `/read/program-state` endpoint with the keys as query params, with credentials.
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.url).toBe(
      "/api/envoy/read/program-state?programKey=weekly&subjectKey=default"
    );
    expect(call.init?.credentials).toBe("same-origin");
  });

  it("trims a trailing slash on basePath", async () => {
    queue.push({ json: { watermark: null, issueSeq: 0, lastFiredAt: null, paused: false } });
    const { result } = renderHook(() =>
      useProgramState({ basePath: "/api/envoy/", programKey: "w", subjectKey: "s" })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(calls[0]!.url).toBe("/api/envoy/read/program-state?programKey=w&subjectKey=s");
  });

  it("edge: surfaces a non-2xx body as the error and clears data", async () => {
    queue.push({ status: 403, text: "forbidden by host authorize" });

    const { result } = renderHook(() =>
      useProgramState({ basePath: "/api/envoy", programKey: "weekly", subjectKey: "default" })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.data).toBeNull();
    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toBe("forbidden by host authorize");
  });

  it("edge: a transport throw surfaces as error state, not an unhandled rejection", async () => {
    queue.push({ throwError: new Error("network down") });

    const { result } = renderHook(() =>
      useProgramState({ basePath: "/api/envoy", programKey: "weekly", subjectKey: "default" })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("network down");
    expect(result.current.data).toBeNull();
  });

  it("edge: stays idle (no fetch) until a key is non-empty", async () => {
    const { result, rerender } = renderHook(
      (props: { programKey: string }) =>
        useProgramState({ basePath: "/api/envoy", programKey: props.programKey, subjectKey: "s" }),
      { initialProps: { programKey: "" } }
    );

    // No fetch fired for an empty key.
    expect(result.current.loading).toBe(false);
    expect(calls).toHaveLength(0);

    queue.push({ json: { watermark: null, issueSeq: 0, lastFiredAt: null, paused: false } });
    rerender({ programKey: "now-known" });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toContain("programKey=now-known");
  });

  it("edge: enabled:false suppresses the fetch", async () => {
    const { result } = renderHook(() =>
      useProgramState({
        basePath: "/api/envoy",
        programKey: "weekly",
        subjectKey: "default",
        enabled: false,
      })
    );
    // Give any (erroneous) async a tick.
    await act(async () => {
      await Promise.resolve();
    });
    expect(calls).toHaveLength(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it("refetch bypasses the cache and re-requests", async () => {
    queue.push({ json: { watermark: "a", issueSeq: 1, lastFiredAt: null, paused: false } });
    const { result } = renderHook(() =>
      useProgramState({ basePath: "/api/envoy", programKey: "weekly", subjectKey: "default" })
    );
    await waitFor(() => expect(result.current.data?.watermark).toBe("a"));
    expect(calls).toHaveLength(1);

    queue.push({ json: { watermark: "b", issueSeq: 2, lastFiredAt: null, paused: false } });
    act(() => {
      result.current.refetch();
    });
    await waitFor(() => expect(result.current.data?.watermark).toBe("b"));
    expect(calls).toHaveLength(2);
  });
});

// --- useConsent ------------------------------------------------------------------------------

describe("useConsent", () => {
  it("happy: fetches the consent mirror row for (email, topic)", async () => {
    const row: ConsentResponse = {
      contact: "a@example.com",
      topicKey: "digest:default",
      topicId: "top_1",
      digest: "opt_in",
      alert: "opt_out",
      dirty: false,
    };
    queue.push({ json: row });

    const { result } = renderHook(() =>
      useConsent({ basePath: "/api/envoy", email: "a@example.com", topicKey: "digest:default" })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(row);
    expect(calls[0]!.url).toBe(
      "/api/envoy/read/consent?email=a%40example.com&topicKey=digest%3Adefault"
    );
  });

  it("edge: idle until both email and topicKey are present", async () => {
    const { result } = renderHook(() =>
      useConsent({ basePath: "/api/envoy", email: "", topicKey: "t" })
    );
    expect(calls).toHaveLength(0);
    expect(result.current.loading).toBe(false);
  });
});

// --- useBroadcastHistory ---------------------------------------------------------------------

describe("useBroadcastHistory", () => {
  it("happy: fetches the issue history list for a program", async () => {
    const history: BroadcastHistoryResponse = {
      items: [
        {
          broadcastKey: "weekly:2026-25",
          resendBroadcastId: "bc_2",
          itemIds: ["i9", "i10"],
          sentAt: "2026-06-20T00:00:00Z",
          createdAt: "2026-06-20T00:00:00Z",
        },
      ],
    };
    queue.push({ json: history });

    const { result } = renderHook(() =>
      useBroadcastHistory({ basePath: "/api/envoy", programKey: "weekly", limit: 10 })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(history);
    expect(calls[0]!.url).toBe(
      "/api/envoy/read/broadcast-history?programKey=weekly&limit=10"
    );
  });

  it("omits the limit param when not given", async () => {
    queue.push({ json: { items: [] } });
    const { result } = renderHook(() =>
      useBroadcastHistory({ basePath: "/api/envoy", programKey: "weekly" })
    );
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(calls[0]!.url).toBe("/api/envoy/read/broadcast-history?programKey=weekly");
  });
});

// --- useAnalytics ----------------------------------------------------------------------------

describe("useAnalytics", () => {
  it("happy: fetches counters and forwards the window/stream filters", async () => {
    const analytics: AnalyticsResponse = {
      sent: 100,
      delivered: 98,
      opened: 40,
      clicked: 12,
      bounced: 2,
      complained: 0,
      unsubscribed: 1,
      window: { from: "2026-06-01", to: "2026-06-21" },
    };
    queue.push({ json: analytics });

    const { result } = renderHook(() =>
      useAnalytics({
        basePath: "/api/envoy",
        from: "2026-06-01",
        to: "2026-06-21",
        stream: "digest",
      })
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.data).toEqual(analytics);
    expect(calls[0]!.url).toBe(
      "/api/envoy/read/analytics?from=2026-06-01&to=2026-06-21&stream=digest"
    );
  });

  it("edge: idle when basePath is empty (the default), no fetch", async () => {
    const { result } = renderHook(() => useAnalytics());
    expect(calls).toHaveLength(0);
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });

  it("error: malformed JSON on a 200 surfaces a parse error", async () => {
    // ok:true but json() throws (no json supplied) → "not valid JSON".
    queue.push({ status: 200, text: "<html>not json</html>" });
    const { result } = renderHook(() => useAnalytics({ basePath: "/api/envoy" }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error?.message).toBe("Read response was not valid JSON.");
  });
});

// --- shared cache behavior -------------------------------------------------------------------

describe("read cache", () => {
  it("dedups two concurrent hooks reading the same url into one request", async () => {
    queue.push({ json: { watermark: "x", issueSeq: 1, lastFiredAt: null, paused: false } });

    const { result } = renderHook(() => {
      const a = useProgramState({ basePath: "/api/envoy", programKey: "w", subjectKey: "s" });
      const b = useProgramState({ basePath: "/api/envoy", programKey: "w", subjectKey: "s" });
      return { a, b };
    });

    await waitFor(() => expect(result.current.a.loading).toBe(false));
    await waitFor(() => expect(result.current.b.loading).toBe(false));

    expect(result.current.a.data?.watermark).toBe("x");
    expect(result.current.b.data?.watermark).toBe("x");
    // One network request despite two hooks on the same url.
    expect(calls).toHaveLength(1);
  });
});
