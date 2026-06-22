"use client";

// @catalystiq/envoy-sdk/client — React hooks entry (read-only state for host-built admin screens).
//
// U17 / origin R4. These are the ONLY hooks the SDK ships. They are deliberately read-only:
// every mutation (enroll, consent.set, broadcast trigger, …) goes through the typed SERVER
// functions on the `Envoy` handle (R3), never through a hook. A hook that could write would
// duplicate the server-side consent gate and namespace boundary in the browser, where the host's
// `authorize` has already run but the SDK's invariants are not enforceable — so writes stay server-
// side and the client surface is pure reads.
//
// Each hook fetches one of the mounted route's `/read/*` endpoints (the route factory, U4, gates
// `/read` with the host's `authorize(req)` — the SAME session cookie the browser already carries,
// so these `fetch` calls inherit credentials with `credentials: "same-origin"`). The host mounts
// the catch-all anywhere, so the hooks take a `basePath` (the mount base, e.g. "/api/envoy"); the
// hook appends `/read/<resource>`. No server-only code is imported here — this module compiles into
// the client bundle (tsup re-injects the "use client" banner since esbuild strips top-of-file
// directives). The response shapes below are the WIRE shapes (JSON the server fns serialize); we
// redefine them locally rather than import the server types so `./client` pulls in nothing from the
// server entry.
//
// Fetch strategy is intentionally minimal (the unit calls for "plain fetch + a tiny cache"): a
// process-level in-flight/result cache keyed by the request URL dedups concurrent identical reads
// and lets a remount read the last value synchronously, with an explicit `refetch()` to invalidate.
// No SWR/React-Query dependency — the SDK ships zero client runtime deps.

import { useCallback, useEffect, useRef, useState } from "react";

export const SDK_CLIENT_VERSION = "0.0.0";

// ---------------------------------------------------------------------------------------------
// Wire shapes (the JSON the `/read/*` endpoints return). Mirrors of the server types, redefined
// here so the client bundle imports nothing server-only.
// ---------------------------------------------------------------------------------------------

/** Per-stream consent value. Mirrors the server `ConsentStatus`. */
export type ClientConsentStatus = "opt_in" | "opt_out" | "unsubscribed";

/** `/read/program-state` — the broadcast cursor state for one (programKey, subjectKey). */
export interface ProgramStateResponse {
  /** High-water mark over the host's ordering column; null for a never-fired (program, subject). */
  watermark: string | null;
  /** Monotonic issue sequence (0 for never-seen). */
  issueSeq: number;
  /** ISO timestamp of the last real send; null when never fired. A stale value is a health signal. */
  lastFiredAt: string | null;
  /** Whether the host has paused this (program, subject). */
  paused: boolean;
}

/** `/read/consent` — the consent mirror row for one (contact, topic). */
export interface ConsentResponse {
  /** Contact email (the host already authorized the viewer; the SDK does not redact in its own UI). */
  contact: string;
  /** Topic key the row is scoped to. */
  topicKey: string;
  /** Cached Resend Topic id (null until provisioned). */
  topicId: string | null;
  /** Digest-stream consent. */
  digest: ClientConsentStatus;
  /** Alert-stream consent. */
  alert: ClientConsentStatus;
  /** True when the mirror and Resend may have diverged (reconcile pending). */
  dirty: boolean;
}

/** One broadcast issue in the `/read/broadcast-history` list. */
export interface BroadcastHistoryItem {
  /** Host-supplied broadcast key (one per issue). */
  broadcastKey: string;
  /** Resend broadcast id, once accepted + persisted; null in the crash gap. */
  resendBroadcastId: string | null;
  /** Host content item ids included in this issue. */
  itemIds: string[];
  /** ISO timestamp the issue was marked sent; null ⇒ unsent ⇒ resumable. */
  sentAt: string | null;
  /** ISO timestamp the claim row was created. */
  createdAt: string;
}

/** `/read/broadcast-history` — most-recent-first list of broadcast issues for a program. */
export interface BroadcastHistoryResponse {
  items: BroadcastHistoryItem[];
}

/** `/read/analytics` — a minimal delivery/engagement contract (the richer model is deferred, see
 *  the plan's open question on analytics depth). The host's read endpoint owns the aggregation; the
 *  hook just surfaces whatever counters it returns plus an optional window echo. */
export interface AnalyticsResponse {
  /** Emails accepted by Resend in the window. */
  sent: number;
  /** Delivery webhooks observed. */
  delivered: number;
  /** Open events observed. */
  opened: number;
  /** Click events observed. */
  clicked: number;
  /** Bounces (hard + soft) observed. */
  bounced: number;
  /** Complaints / spam reports observed. */
  complained: number;
  /** Unsubscribes observed. */
  unsubscribed: number;
  /** Optional echo of the requested window (ISO dates), present when the host's endpoint sets it. */
  window?: { from: string | null; to: string | null };
}

// ---------------------------------------------------------------------------------------------
// Shared hook machinery
// ---------------------------------------------------------------------------------------------

/** The state every read hook returns. `data` is null until the first successful load. */
export interface ReadState<T> {
  /** The last successfully fetched value, or null before the first success / after a reset. */
  data: T | null;
  /** A truthy error from the last attempt, or null on success. The message is host-controlled (the
   *  read endpoint's body) when the response was a non-2xx; a transport failure surfaces its own. */
  error: Error | null;
  /** True while a request is in flight (including the initial load and any `refetch`). */
  loading: boolean;
  /** Re-run the fetch, bypassing the cache (e.g. after the host mutated state via a server fn). */
  refetch: () => void;
}

/** Options common to every hook. */
export interface ReadHookOptions {
  /**
   * The mount base of the host's catch-all route (e.g. "/api/envoy"). The hook appends
   * `/read/<resource>`. Required — the SDK is mount-agnostic and cannot guess the host's path.
   */
  basePath: string;
  /**
   * Skip fetching while false (e.g. gate a hook on a not-yet-known key, the React-Query `enabled`
   * convention). Defaults to true.
   */
  enabled?: boolean;
}

interface CacheEntry<T> {
  /** Resolved value, if a fetch has completed for this URL. */
  value?: T;
  /** Error, if the last fetch for this URL failed. */
  error?: Error;
  /** In-flight promise, so concurrent hooks reading the same URL share one request. */
  promise?: Promise<void>;
}

// Module-level cache keyed by absolute request URL. Tiny by design — no eviction policy; an admin
// surface reads a bounded set of keys, and `refetch` clears an entry explicitly. Kept off any React
// context so multiple independent hook instances dedup naturally.
const readCache = new Map<string, CacheEntry<unknown>>();

/** Test/SSR seam: clear the shared read cache (used by tests; harmless in prod). */
export function __clearReadCache(): void {
  readCache.clear();
}

/**
 * Build the absolute `/read/<resource>` URL. `basePath` is trimmed of a trailing slash; `params`
 * are appended as a query string (undefined values dropped). A leading-slash-less basePath is left
 * as-is (relative URLs are valid for same-origin `fetch`).
 */
function buildReadUrl(
  basePath: string,
  resource: string,
  params: Record<string, string | number | undefined>
): string {
  const base = basePath.endsWith("/") ? basePath.slice(0, -1) : basePath;
  const search = new URLSearchParams();
  for (const [key, raw] of Object.entries(params)) {
    if (raw === undefined) continue;
    search.set(key, String(raw));
  }
  const qs = search.toString();
  return `${base}/read/${resource}${qs ? `?${qs}` : ""}`;
}

/**
 * Fetch one read URL, sharing in-flight requests via {@link readCache}. On a non-2xx the body text
 * becomes the error message (falling back to the status line) so a host-emitted error reaches the
 * hook's `error` state rather than a generic failure. A network throw surfaces verbatim.
 */
async function fetchRead<T>(url: string, signal: AbortSignal): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: "GET",
      // The `/read` gate is the host's `authorize(req)` over the browser's existing session, so the
      // request must carry credentials. Same-origin only — the SDK never reads cross-origin.
      credentials: "same-origin",
      headers: { accept: "application/json" },
      signal,
    });
  } catch (err) {
    // Transport failure (offline, DNS, abort). An AbortError is rethrown so the caller can ignore it.
    throw err instanceof Error ? err : new Error(String(err));
  }

  if (!res.ok) {
    let detail = "";
    try {
      detail = (await res.text()).trim();
    } catch {
      detail = "";
    }
    throw new Error(detail.length > 0 ? detail : `Read request failed (${res.status}).`);
  }

  try {
    return (await res.json()) as T;
  } catch {
    throw new Error("Read response was not valid JSON.");
  }
}

/**
 * The shared read hook. Fetches `url` (when `enabled`), exposing `{ data, error, loading, refetch }`.
 * A `null` url (a not-yet-resolvable key) holds the hook in an idle, non-loading state. Concurrent
 * instances of the same url share one request via the module cache; `refetch` drops the cache entry
 * and re-requests. An in-flight request is aborted on unmount / url change so a late resolve never
 * sets state on an unmounted component.
 */
function useRead<T>(url: string | null, enabled: boolean): ReadState<T> {
  const [data, setData] = useState<T | null>(() => {
    if (url === null) return null;
    const cached = readCache.get(url);
    return (cached?.value as T | undefined) ?? null;
  });
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState<boolean>(false);

  // Bump to force a cache-bypassing refetch.
  const [nonce, setNonce] = useState(0);

  // Track mount so an async resolve after unmount is a no-op (avoids the React "set state on
  // unmounted component" class of bug without leaning on a ref-to-isMounted hack per call).
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refetch = useCallback(() => {
    if (url !== null) readCache.delete(url);
    setNonce((n) => n + 1);
  }, [url]);

  useEffect(() => {
    if (!enabled || url === null) {
      // Idle: not loading, no error, keep any prior data so a disable→enable flip doesn't flash.
      setLoading(false);
      return;
    }

    const controller = new AbortController();
    let active = true;

    const cached = readCache.get(url);
    if (cached && cached.value !== undefined && cached.error === undefined) {
      // Synchronous cache hit — surface immediately, no spinner.
      setData(cached.value as T);
      setError(null);
      setLoading(false);
      return () => {
        active = false;
        controller.abort();
      };
    }

    setLoading(true);
    setError(null);

    // Reuse an in-flight request for this url if one exists; otherwise start one and memoize it.
    let entry = readCache.get(url);
    if (!entry || entry.promise === undefined) {
      entry = entry ?? {};
      entry.promise = fetchRead<T>(url, controller.signal)
        .then((value) => {
          entry!.value = value;
          entry!.error = undefined;
        })
        .catch((err: unknown) => {
          // An abort is not a real error — leave the entry untouched so a later mount can retry.
          if (isAbortError(err)) return;
          entry!.error = err instanceof Error ? err : new Error(String(err));
          entry!.value = undefined;
        })
        .finally(() => {
          entry!.promise = undefined;
        });
      readCache.set(url, entry);
    }

    entry.promise
      .then(() => {
        if (!active || !mountedRef.current) return;
        const settled = readCache.get(url);
        if (settled?.error !== undefined) {
          setError(settled.error);
          setData(null);
        } else if (settled?.value !== undefined) {
          setData(settled.value as T);
          setError(null);
        }
        setLoading(false);
      })
      .catch(() => {
        // The shared promise never rejects (errors are captured onto the entry); this is a guard.
        if (active && mountedRef.current) setLoading(false);
      });

    return () => {
      active = false;
      controller.abort();
    };
    // `nonce` re-runs the effect after a `refetch` (the entry was just deleted, forcing a real fetch).
  }, [url, enabled, nonce]);

  return { data, error, loading, refetch };
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error && (err.name === "AbortError" || err.message.toLowerCase().includes("abort"))
  );
}

// ---------------------------------------------------------------------------------------------
// The four read hooks (R4)
// ---------------------------------------------------------------------------------------------

/** Args for {@link useProgramState}. */
export interface UseProgramStateArgs extends ReadHookOptions {
  /** Broadcast program key (a `defineBroadcastProgram` key). */
  programKey: string;
  /** Subject the watermark advances over (often "default" for a simple newsletter). */
  subjectKey: string;
}

/**
 * Read the broadcast cursor state for one (programKey, subjectKey) via `/read/program-state`. Use it
 * on an admin screen to show the watermark / issue sequence / last-fired health timestamp / paused
 * flag. Read-only — pause/advance happen through server fns.
 */
export function useProgramState(args: UseProgramStateArgs): ReadState<ProgramStateResponse> {
  const { basePath, enabled = true, programKey, subjectKey } = args;
  const ready = programKey.length > 0 && subjectKey.length > 0;
  const url = ready ? buildReadUrl(basePath, "program-state", { programKey, subjectKey }) : null;
  return useRead<ProgramStateResponse>(url, enabled);
}

/** Args for {@link useConsent}. */
export interface UseConsentArgs extends ReadHookOptions {
  /** Contact email. */
  email: string;
  /** Topic key to read the mirror row for. */
  topicKey: string;
}

/**
 * Read the consent mirror row for one (contact, topic) via `/read/consent`. Surfaces the per-stream
 * (digest/alert) statuses and the dirty flag so an admin can see what the gate will decide. The
 * mirror is authoritative — this reflects exactly what a send checks.
 */
export function useConsent(args: UseConsentArgs): ReadState<ConsentResponse> {
  const { basePath, enabled = true, email, topicKey } = args;
  const ready = email.length > 0 && topicKey.length > 0;
  const url = ready ? buildReadUrl(basePath, "consent", { email, topicKey }) : null;
  return useRead<ConsentResponse>(url, enabled);
}

/** Args for {@link useBroadcastHistory}. */
export interface UseBroadcastHistoryArgs extends ReadHookOptions {
  /** Broadcast program key to list issues for. */
  programKey: string;
  /** Max issues to fetch (the host endpoint caps/paginates; this is a hint). */
  limit?: number;
}

/**
 * Read the broadcast issue history for a program via `/read/broadcast-history` (most-recent-first).
 * Each item is a claim row: key, Resend id, item ids, sent/created timestamps. Read-only.
 */
export function useBroadcastHistory(
  args: UseBroadcastHistoryArgs
): ReadState<BroadcastHistoryResponse> {
  const { basePath, enabled = true, programKey, limit } = args;
  const ready = programKey.length > 0;
  const url = ready ? buildReadUrl(basePath, "broadcast-history", { programKey, limit }) : null;
  return useRead<BroadcastHistoryResponse>(url, enabled);
}

/** Args for {@link useAnalytics}. */
export interface UseAnalyticsArgs extends ReadHookOptions {
  /** Optional ISO window start (inclusive). */
  from?: string;
  /** Optional ISO window end (inclusive). */
  to?: string;
  /** Optional stream filter ("digest" / "alert" / a custom stream name). */
  stream?: string;
}

/**
 * Read delivery/engagement counters via `/read/analytics`. The contract here is intentionally
 * minimal (the richer analytics model is deferred); the host's endpoint owns the aggregation and
 * may echo the requested window. Read-only.
 */
export function useAnalytics(args: UseAnalyticsArgs = { basePath: "" }): ReadState<AnalyticsResponse> {
  const { basePath, enabled = true, from, to, stream } = args;
  const ready = basePath.length > 0;
  const url = ready ? buildReadUrl(basePath, "analytics", { from, to, stream }) : null;
  return useRead<AnalyticsResponse>(url, enabled);
}
