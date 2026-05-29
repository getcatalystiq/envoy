import { vi } from "vitest";

export interface MockFetchCall {
  url: string;
  init: RequestInit;
}

export interface MockResponseSpec {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

/**
 * Test helper: stub global fetch with a queue of responses. Each call pops the
 * next response from the queue. If the queue empties, subsequent calls throw.
 * Recorded calls are exposed for assertions.
 */
export function mockFetchQueue(responses: MockResponseSpec[]) {
  const calls: MockFetchCall[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (url: string | URL | Request, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const spec = queue.shift();
    if (!spec) {
      throw new Error(`mockFetchQueue exhausted; got call to ${url}`);
    }
    const status = spec.status ?? 200;
    const headers = new Headers(spec.headers ?? { "Content-Type": "application/json" });
    // 204/205/304 cannot have a body per the Response spec.
    if (status === 204 || status === 205 || status === 304) {
      return new Response(null, { status, headers });
    }
    const body =
      spec.body === undefined
        ? ""
        : typeof spec.body === "string"
        ? spec.body
        : JSON.stringify(spec.body);
    return new Response(body, { status, headers });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { calls, fetchMock, remaining: () => queue.length };
}

export function restoreFetch() {
  vi.unstubAllGlobals();
}
