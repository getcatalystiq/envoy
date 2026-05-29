import { getEnv } from "@/lib/env";
import { formatTargetForPrompt } from "@/lib/twin-sanitize";

export class TwinError extends Error {
  readonly status: number;
  readonly detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "TwinError";
    this.status = status;
    this.detail = detail;
  }
}

export interface RunResult {
  output: string;
  runId: string;
  status: string;
  outcome?: string;
  metadata?: Record<string, unknown>;
}

export interface TwinRunEvent {
  event_index: number;
  recorded_at: string;
  event: Record<string, unknown>;
}

// Backwards-compatible alias.
export type RunEvent = TwinRunEvent;

export interface TwinRun {
  run_id: string;
  agent_id: string;
  status?: string | null;
  is_finished: boolean;
  started_at: string;
  last_event_at: string;
  event_count: number;
  step_count: number;
  run_number: number;
  policy_type?: string | null;
  goal?: string | null;
}

export interface TwinAgent {
  agent_id: string;
  latest_run_id?: string | null;
  latest_run_is_finished?: boolean;
  has_runs?: boolean;
  workspace_id?: string | null;
  deployment_state?: string | null;
  last_activity_at?: string | null;
  deployed_at?: string | null;
  [key: string]: unknown;
}

const RUN_POLL_INTERVAL_MS = 2000;
const RUN_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRY_5XX_SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
const MAX_FETCH_RETRIES = 3;

function combineSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  const controller = new AbortController();
  const abort = (reason?: unknown) => controller.abort(reason);
  if (a.aborted) abort(a.reason);
  else a.addEventListener("abort", () => abort(a.reason), { once: true });
  if (b.aborted) abort(b.reason);
  else b.addEventListener("abort", () => abort(b.reason), { once: true });
  return controller.signal;
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    return delta > 0 ? delta : 0;
  }
  return null;
}

async function twinFetch<T>(
  path: string,
  init: RequestInit & {
    signal?: AbortSignal;
    timeoutMs?: number;
    apiKey?: string;
  } = {},
): Promise<T> {
  const env = getEnv();
  const url = `${env.TWIN_API_URL.replace(/\/$/, "")}${path}`;
  const timeoutMs = init.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const apiKey = init.apiKey ?? env.TWIN_API_KEY;

  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = init.signal
      ? combineSignals(init.signal, controller.signal)
      : controller.signal;

    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal,
        headers: {
          "x-api-key": apiKey,
          "Content-Type": "application/json",
          ...(init.headers ?? {}),
        },
      });
    } catch (err) {
      clearTimeout(timer);
      // If caller's signal aborted, surface that directly.
      if (init.signal?.aborted) {
        throw new TwinError("Twin request aborted", 499);
      }
      if (controller.signal.aborted) {
        // Timeout — only retry for idempotent methods. We don't know whether a
        // non-idempotent request (POST/PUT/DELETE/PATCH) reached the server.
        const method = (init.method ?? "GET").toUpperCase();
        if (
          RETRY_5XX_SAFE_METHODS.has(method) &&
          attempt < MAX_FETCH_RETRIES
        ) {
          const backoff = 100 * Math.pow(4, attempt) + Math.random() * 100;
          attempt++;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
        throw new TwinError(`Twin request timed out after ${timeoutMs}ms`, 504);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 204) {
      return undefined as T;
    }

    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = text;
      }
    }

    if (!res.ok) {
      if (RETRY_STATUSES.has(res.status) && attempt < MAX_FETCH_RETRIES) {
        const method = (init.method ?? "GET").toUpperCase();
        // 429 is always retryable (server says it didn't do the work).
        // 5xx is only retryable for idempotent methods because we don't
        // know whether the server processed the request.
        const isRetryable =
          res.status === 429 || RETRY_5XX_SAFE_METHODS.has(method);
        if (isRetryable) {
          const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
          const backoff =
            retryAfter ?? 100 * Math.pow(4, attempt) + Math.random() * 100;
          attempt++;
          await new Promise((r) => setTimeout(r, backoff));
          continue;
        }
      }
      const problem = (parsed as Record<string, unknown>) ?? {};
      throw new TwinError(
        (problem.title as string) ?? `Twin API error ${res.status}`,
        res.status,
        (problem.detail as string) ?? (typeof parsed === "string" ? parsed : undefined),
      );
    }

    return parsed as T;
  }
}

/** Per-call options shared by every Twin client function. The per-org Twin
 * API key flows through this `apiKey` field; when unset twinFetch falls back
 * to the TWIN_API_KEY env var. */
export interface TwinCallOpts {
  apiKey?: string;
}

export async function getAgent(
  agentId: string,
  opts: TwinCallOpts = {},
): Promise<TwinAgent> {
  const data = await twinFetch<{ agent: TwinAgent }>(
    `/v1/agents/${encodeURIComponent(agentId)}`,
    { apiKey: opts.apiKey },
  );
  return data.agent;
}

export async function listAgents(
  opts: {
    workspaceId?: string;
    cursor?: string;
    limit?: number;
  } & TwinCallOpts = {},
): Promise<{ agents: TwinAgent[] }> {
  const qs = new URLSearchParams();
  if (opts.workspaceId) qs.set("workspace_id", opts.workspaceId);
  if (opts.cursor) qs.set("cursor", opts.cursor);
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  const suffix = qs.toString() ? `?${qs}` : "";
  return twinFetch<{ agents: TwinAgent[] }>(`/v1/agents${suffix}`, {
    apiKey: opts.apiKey,
  });
}

export async function getInstructions(
  agentId: string,
  opts: TwinCallOpts = {},
): Promise<{ content: string } | null> {
  const data = await twinFetch<{ instructions: { content: string } | null }>(
    `/v1/agents/${encodeURIComponent(agentId)}/instructions`,
    { apiKey: opts.apiKey },
  );
  return data.instructions;
}

export async function updateInstructions(
  agentId: string,
  content: string,
  opts: TwinCallOpts = {},
): Promise<void> {
  await twinFetch<{ success: boolean }>(
    `/v1/agents/${encodeURIComponent(agentId)}/instructions`,
    {
      method: "PUT",
      body: JSON.stringify({ content, source_type: "api" }),
      apiKey: opts.apiKey,
    },
  );
}

export interface ListRunsOptions {
  page?: number;
  pageSize?: number;
  filterStatus?: string;
  filterRunId?: string;
  filterStartedAfter?: string;
  filterStartedBefore?: string;
  filterPolicyType?: string;
  filterPolicyGroup?: "builder" | "runner";
}

export interface ListRunsResult {
  runs: TwinRun[];
  total_runs: number;
  page: number;
  page_size: number;
}

export async function listRuns(
  agentId: string,
  opts: ListRunsOptions & TwinCallOpts = {},
): Promise<ListRunsResult> {
  const qs = new URLSearchParams();
  if (opts.page !== undefined) qs.set("page", String(opts.page));
  if (opts.pageSize !== undefined) qs.set("page_size", String(opts.pageSize));
  if (opts.filterStatus) qs.set("filter_status", opts.filterStatus);
  if (opts.filterRunId) qs.set("filter_run_id", opts.filterRunId);
  if (opts.filterStartedAfter) qs.set("filter_started_after", opts.filterStartedAfter);
  if (opts.filterStartedBefore) qs.set("filter_started_before", opts.filterStartedBefore);
  if (opts.filterPolicyType) qs.set("filter_policy_type", opts.filterPolicyType);
  if (opts.filterPolicyGroup) qs.set("filter_policy_group", opts.filterPolicyGroup);
  const suffix = qs.toString() ? `?${qs}` : "";
  const raw = await twinFetch<{
    runs: TwinRun[];
    total_runs: string | number;
    page: number;
    page_size: number;
  }>(`/v1/agents/${encodeURIComponent(agentId)}/runs${suffix}`, {
    apiKey: opts.apiKey,
  });
  return {
    runs: raw.runs,
    total_runs: Number(raw.total_runs) || 0,
    page: raw.page,
    page_size: raw.page_size,
  };
}

export async function getRun(
  agentId: string,
  runId: string,
  opts: TwinCallOpts = {},
): Promise<TwinRun | null> {
  const data = await listRuns(agentId, {
    filterRunId: runId,
    pageSize: 1,
    apiKey: opts.apiKey,
  });
  return data.runs[0] ?? null;
}

/**
 * Defense-in-depth ownership check: verify a run belongs to an agent before
 * performing operations on it. Throws TwinError(404) if not found.
 */
export async function assertRunBelongsToAgent(
  agentId: string,
  runId: string,
  opts: TwinCallOpts = {},
): Promise<void> {
  const result = await listRuns(agentId, {
    filterRunId: runId,
    pageSize: 1,
    apiKey: opts.apiKey,
  });
  if (!result.runs[0]) {
    throw new TwinError("Run not found", 404);
  }
}

export async function startRun(
  agentId: string,
  opts: {
    runMode?: "build" | "run";
    userMessage?: string;
    skipDeployCheck?: boolean;
  } & TwinCallOpts = {},
): Promise<TwinRun> {
  const body: Record<string, unknown> = {};
  if (opts.runMode) body.run_mode = opts.runMode;
  if (opts.userMessage) body.user_message = opts.userMessage;
  if (opts.skipDeployCheck) body.skip_deploy_check = opts.skipDeployCheck;
  const data = await twinFetch<{ run: TwinRun }>(
    `/v1/agents/${encodeURIComponent(agentId)}/runs`,
    { method: "POST", body: JSON.stringify(body), apiKey: opts.apiKey },
  );
  return data.run;
}

export async function cancelRun(
  agentId: string,
  runId: string,
  reason?: string,
  opts: TwinCallOpts = {},
): Promise<void> {
  await twinFetch(
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/cancel`,
    {
      method: "POST",
      body: JSON.stringify(reason ? { reason } : {}),
      apiKey: opts.apiKey,
    },
  );
}

export async function deleteRun(
  agentId: string,
  runId: string,
  opts: TwinCallOpts = {},
): Promise<void> {
  await twinFetch(
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}`,
    { method: "DELETE", apiKey: opts.apiKey },
  );
}

export async function listRunEvents(
  agentId: string,
  runId: string,
  opts: { limit?: number; afterIndex?: number } & TwinCallOpts = {},
): Promise<{ events: TwinRunEvent[]; total_count: number }> {
  const qs = new URLSearchParams();
  if (opts.limit !== undefined) qs.set("limit", String(opts.limit));
  if (typeof opts.afterIndex === "number") qs.set("after_index", String(opts.afterIndex));
  const suffix = qs.toString() ? `?${qs}` : "";
  return twinFetch(
    `/v1/agents/${encodeURIComponent(agentId)}/runs/${encodeURIComponent(runId)}/events${suffix}`,
    { apiKey: opts.apiKey },
  );
}

const TERMINAL_EVENT_NAMES = new Set([
  "finished",
  "completed",
  "failed",
  "errored",
  "cancelled",
  "canceled",
]);

/**
 * Twin run events are deeply nested and typed-by-key:
 *   events[i].event = { agent_id, event: { event: { <EventType>: {...} } }, run_id, user_id }
 * Descend through the `event` wrappers to the single capitalized type key and
 * return `{ type, data }`. Returns null if the shape isn't recognized.
 */
function unwrapEventPayload(
  raw: unknown,
): { type: string; data: Record<string, unknown> } | null {
  let node: unknown = raw;
  for (
    let i = 0;
    i < 8 &&
    node &&
    typeof node === "object" &&
    !Array.isArray(node) &&
    "event" in (node as Record<string, unknown>) &&
    typeof (node as Record<string, unknown>).event === "object";
    i++
  ) {
    node = (node as Record<string, unknown>).event;
  }
  if (!node || typeof node !== "object" || Array.isArray(node)) return null;
  const keys = Object.keys(node as Record<string, unknown>);
  if (keys.length === 0) return null;
  const type = keys[0];
  const data = (node as Record<string, unknown>)[type];
  return {
    type,
    data:
      data && typeof data === "object" && !Array.isArray(data)
        ? (data as Record<string, unknown>)
        : {},
  };
}

/**
 * Decode Twin's protobuf-style `Value` tree (StructValue / StringValue /
 * ListValue / kind wrappers) into a plain JS value. Tool-call outputs arrive in
 * this encoding, e.g. { kind: { StructValue: { fields: { body: { kind: {
 * StringValue: "..." } } } } } } -> { body: "..." }.
 */
function decodeTwinValue(v: unknown): unknown {
  if (v == null || typeof v !== "object") return v;
  const o = v as Record<string, unknown>;
  if ("kind" in o) return decodeTwinValue(o.kind);
  if ("StringValue" in o) return o.StringValue;
  if ("BoolValue" in o) return o.BoolValue;
  if ("NumberValue" in o) return o.NumberValue;
  if ("NullValue" in o) return null;
  if ("StructValue" in o) return decodeTwinValue(o.StructValue);
  if ("ListValue" in o) return decodeTwinValue(o.ListValue);
  if ("fields" in o && o.fields && typeof o.fields === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(o.fields as Record<string, unknown>)) {
      out[k] = decodeTwinValue(val);
    }
    return out;
  }
  if ("values" in o && Array.isArray(o.values)) {
    return (o.values as unknown[]).map(decodeTwinValue);
  }
  return v;
}

function eventLooksTerminal(rawEvent: Record<string, unknown>): boolean {
  const p = unwrapEventPayload(rawEvent);
  if (!p) return false;
  return TERMINAL_EVENT_NAMES.has(p.type.toLowerCase());
}

/**
 * Extract the agent's final output text from a run's events.
 *
 * Twin agents that emit structured JSON do so as an `llm` tool result — the
 * latest `ToolCallResolved` (tool_name "llm") whose decoded output is an object
 * carrying `body`/`subject`. We return that object re-serialized so callers'
 * JSON parsing (runAgentJson) yields `{ body, subject, ... }`. Falls back to
 * generic assistant-message / text shapes for other agent types. Returns ""
 * when nothing recognizable is present so callers can detect empty output.
 */
function extractFinalOutput(events: TwinRunEvent[]): string {
  // Primary: the most recent llm tool result that produced a JSON object.
  for (let i = events.length - 1; i >= 0; i--) {
    const p = unwrapEventPayload(events[i].event);
    if (!p || p.type !== "ToolCallResolved") continue;
    if (p.data.tool_name !== "llm") continue;
    const decoded = decodeTwinValue(p.data.output);
    if (decoded && typeof decoded === "object" && !Array.isArray(decoded)) {
      const obj = decoded as Record<string, unknown>;
      if (typeof obj.body === "string" || typeof obj.subject === "string") {
        return JSON.stringify(obj);
      }
    }
    if (typeof decoded === "string" && decoded.trim().length > 0) return decoded;
  }

  // Fallback: generic assistant-message / text shapes (non-llm-tool agents).
  for (let i = events.length - 1; i >= 0; i--) {
    const p = unwrapEventPayload(events[i].event);
    if (!p) continue;
    const d = p.data;
    const message =
      (d.message as Record<string, unknown> | undefined) ??
      (d.assistant_message as Record<string, unknown> | undefined) ??
      (d.output as Record<string, unknown> | undefined);
    if (message && typeof message === "object") {
      const text =
        (message.text as string) ??
        (message.content as string) ??
        (message.body as string);
      if (typeof text === "string" && text.length > 0) return text;
    }
    const direct = d.text ?? d.content ?? d.output;
    if (typeof direct === "string" && direct.length > 0) return direct;
  }

  return "";
}

/**
 * Start a run (or resume polling an existing one), then poll until it is
 * finished. Returns the final output text. Uses Run mode by default — agents
 * must already be deployed.
 *
 * When `existingRunId` is provided, `startRun` is skipped and polling resumes
 * against that run_id. This is how callers achieve idempotency across crashes:
 * persist the run_id after the first startRun, and pass it back on retry so
 * the same Twin run is observed instead of billed twice.
 */
export async function runAgent(
  agentId: string,
  userMessage: string,
  opts: {
    runMode?: "build" | "run";
    timeoutMs?: number;
    signal?: AbortSignal;
    existingRunId?: string;
  } & TwinCallOpts = {},
): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;
  const run = opts.existingRunId
    ? ({ run_id: opts.existingRunId } as TwinRun)
    : await startRun(agentId, {
        runMode: opts.runMode ?? "run",
        userMessage,
        apiKey: opts.apiKey,
      });

  const deadline = Date.now() + timeoutMs;
  let afterIndex = -1;
  const allEvents: TwinRunEvent[] = [];
  let finalRun: TwinRun | null = opts.existingRunId ? null : run;
  let consecutiveFailures = 0;
  let sawTerminalEvent = false;

  try {
    while (Date.now() < deadline) {
      if (opts.signal?.aborted) {
        throw new TwinError("Run polling aborted", 499);
      }

      try {
        const { events } = await listRunEvents(agentId, run.run_id, {
          afterIndex: afterIndex >= 0 ? afterIndex : undefined,
          limit: 200,
          apiKey: opts.apiKey,
        });

        if (events.length > 0) {
          allEvents.push(...events);
          afterIndex = events[events.length - 1].event_index;
          for (const ev of events) {
            if (eventLooksTerminal(ev.event)) {
              sawTerminalEvent = true;
              break;
            }
          }
        }

        consecutiveFailures = 0;
      } catch (err) {
        consecutiveFailures++;
        console.warn(
          `Twin poll error (${consecutiveFailures} in a row) for run ${run.run_id}:`,
          err,
        );
        if (consecutiveFailures >= 3) throw err;
      }

      if (sawTerminalEvent) break;

      await new Promise((r) => setTimeout(r, RUN_POLL_INTERVAL_MS));
    }

    // Final reconciliation: confirm with getRun once after the loop exits.
    try {
      const reconciled = await getRun(agentId, run.run_id, {
        apiKey: opts.apiKey,
      });
      if (reconciled) finalRun = reconciled;
    } catch (err) {
      console.warn(`Twin final reconciliation failed for run ${run.run_id}:`, err);
    }

    if (!finalRun?.is_finished && !sawTerminalEvent) {
      throw new TwinError(
        `Run ${run.run_id} did not finish within ${timeoutMs}ms`,
        504,
      );
    }
  } catch (err) {
    // Best-effort cancel on abort/timeout/error so we don't leak server runs.
    // Skip when resuming an existing run — the caller is tracking the run_id
    // for retry and a cancel here would defeat the idempotency.
    if (!opts.existingRunId) {
      await cancelRun(agentId, run.run_id, "aborted/timed-out", {
        apiKey: opts.apiKey,
      }).catch(() => {});
    }
    throw err;
  }

  if (!finalRun) {
    // We never managed to reconcile the run (e.g. resuming an existing run
    // but the final getRun failed). Surface as a 502 so callers leave any
    // persisted run_id marker in place for retry instead of treating the
    // result as a fabricated "finished" run.
    throw new TwinError(
      `Could not reconcile run ${run.run_id}`,
      502,
    );
  }
  const settledRun = finalRun;
  return {
    runId: settledRun.run_id,
    status: settledRun.status ?? "finished",
    output: extractFinalOutput(allEvents),
    metadata: {
      event_count: settledRun.event_count,
      step_count: settledRun.step_count,
      started_at: settledRun.started_at,
      last_event_at: settledRun.last_event_at,
    },
  };
}

/**
 * Run an agent expecting a JSON response. Parses the output as JSON,
 * unwrapping a ```json``` code fence if present. Returns the raw text
 * wrapped in `{ raw: ... }` only when JSON parsing succeeded but the
 * shape didn't include body/subject. Throws TwinError on empty output
 * or true parse failure.
 */
export async function runAgentJson(
  agentId: string,
  userMessage: string,
  opts: {
    timeoutMs?: number;
    signal?: AbortSignal;
    existingRunId?: string;
  } & TwinCallOpts = {},
): Promise<Record<string, unknown>> {
  const result = await runAgent(agentId, userMessage, opts);
  return parseJsonResponse(result.output);
}

function parseJsonResponse(response: string): Record<string, unknown> {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new TwinError("Twin returned empty output", 502);
  }

  let parsedJson: unknown;
  let parsedSuccessfully = false;
  try {
    if (trimmed.includes("```json")) {
      const start = trimmed.indexOf("```json") + 7;
      const end = trimmed.indexOf("```", start);
      if (end > start) {
        parsedJson = JSON.parse(trimmed.substring(start, end).trim());
        parsedSuccessfully = true;
      }
    }
    if (!parsedSuccessfully) {
      parsedJson = JSON.parse(trimmed);
      parsedSuccessfully = true;
    }
  } catch {
    throw new TwinError("Twin response was not valid JSON", 502, response.slice(0, 500));
  }

  if (
    parsedJson &&
    typeof parsedJson === "object" &&
    !Array.isArray(parsedJson)
  ) {
    return parsedJson as Record<string, unknown>;
  }
  // JSON parsed but isn't an object (e.g., string/array/number) — surface as raw.
  return { raw: response };
}

/**
 * Generate email content for a target via the Twin agent.
 * The agent is responsible for understanding what content to produce —
 * we just describe the target and content type.
 */
export async function generateContent(
  agentId: string,
  target: Record<string, unknown>,
  contentType: string,
  opts: TwinCallOpts = {},
): Promise<Record<string, unknown>> {
  // Allowlist gate + prompt-injection delimiters: never ship the raw target row
  // to Twin, and frame it as untrusted data (see twin-sanitize).
  const message =
    `Generate ${contentType} email content for this target.\n\n` +
    `${formatTargetForPrompt(target)}\n\n` +
    `Respond with JSON containing "subject" and "body" fields. ` +
    `Optionally include a "confidence_score" between 0 and 1.`;
  return runAgentJson(agentId, message, { apiKey: opts.apiKey });
}
