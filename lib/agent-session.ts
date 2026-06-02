import Anthropic from "@anthropic-ai/sdk";

import { formatTargetForPrompt } from "@/lib/agent-sanitize";

/**
 * Claude Managed Agents client — replaces the Twin REST client (`lib/twin.ts`).
 *
 * Lifecycle per call: `sessions.create` -> open the SSE stream -> send the
 * structured-goal JSON as a single `user.message` -> accumulate `agent.message`
 * text per message -> stop on `session.status_idle`. The output is content-seek
 * extracted (newest message that parses to `{body}`/`{subject,body}`), then fed
 * to `parseJsonResponse`. All SDK contact is isolated in this module so a beta
 * API change (`managed-agents-2026-04-01`) touches one file.
 */

export class AgentError extends Error {
  readonly status: number;
  readonly detail?: string;
  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "AgentError";
    this.status = status;
    this.detail = detail;
  }
}

export interface AgentSessionResult {
  output: string;
  sessionId: string;
}

export interface AgentCallOpts {
  /** Per-call invocation timeout. Defaults to 10 minutes. */
  timeoutMs?: number;
  /** Vault ids the session may use for stored credentials (so the agent's MCP
   * servers can authenticate). Passed as `vault_ids` to `sessions.create`. */
  vaultIds?: string[];
  /**
   * Invoked with the new session id immediately after `sessions.create` and
   * BEFORE the billed `events.send` turn — so a caller can persist the id as an
   * inflight crash-resume marker that always precedes any billed work. If it
   * throws, the (un-sent, unbilled) session is archived and the call fails.
   */
  onSessionCreated?: (sessionId: string) => void | Promise<void>;
}

// Matches the prior Twin run timeout (10 min). The cron's 800s maxDuration
// gives ~200s of headroom for cleanup after this fires.
const RUN_TIMEOUT_MS = 10 * 60 * 1000;

let _client: Anthropic | null = null;

/**
 * Singleton client. Reads `ANTHROPIC_API_KEY` from env. `maxRetries` covers
 * 429 / transient 5xx with the SDK's built-in exponential backoff (this is the
 * 429-retry the old `twinFetch` had — we get it natively here).
 */
function getClient(): Anthropic {
  if (!_client) {
    _client = new Anthropic({ maxRetries: 3 });
  }
  return _client;
}

// The beta event/session shapes are typed in the SDK, but we narrow on the
// `type` discriminator and read a couple of fields loosely so a beta-shape
// change is contained here rather than rippling through callers.
type AnyEvent = { type?: string; [k: string]: unknown };

function messageText(event: AnyEvent): string {
  const content = event.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b) => (b as { type?: string }).type === "text")
    .map((b) => (b as { text?: string }).text ?? "")
    .join("");
}

async function archiveQuietly(client: Anthropic, sessionId: string): Promise<void> {
  // Best-effort cleanup so a timed-out/errored session can't keep billing.
  // Its failure never changes the thrown error.
  try {
    await client.beta.sessions.archive(sessionId);
  } catch {
    /* ignore */
  }
}

function toAgentError(err: unknown, fallback: string): AgentError {
  if (err instanceof AgentError) return err;
  if (err instanceof Anthropic.APIError) {
    const status = err.status ?? 502;
    // Upstream auth failures (Anthropic 401/403) must NOT surface as 401 — the
    // frontend treats any 401 as an Envoy session expiry and logs the user out.
    // Map them to 502 (see the Twin 401->502 lesson).
    const mapped = status === 401 || status === 403 ? 502 : status;
    return new AgentError(err.message || fallback, mapped, err.message);
  }
  return new AgentError(err instanceof Error ? err.message : fallback, 502);
}

/**
 * Drive one Managed Agents session to completion and return the agent's output
 * text plus the session id. Throws `AgentError` on session error (502) or
 * timeout (504).
 */
export async function runAgentSession(
  agentId: string,
  environmentId: string,
  userMessage: string,
  opts: AgentCallOpts = {},
): Promise<AgentSessionResult> {
  const client = getClient();
  const timeoutMs = opts.timeoutMs ?? RUN_TIMEOUT_MS;

  let sessionId: string;
  try {
    const session = await client.beta.sessions.create({
      agent: { type: "agent", id: agentId },
      environment_id: environmentId,
      ...(opts.vaultIds && opts.vaultIds.length > 0
        ? { vault_ids: opts.vaultIds }
        : {}),
    });
    sessionId = session.id;
  } catch (err) {
    throw toAgentError(err, "Failed to create agent session");
  }

  // Persist the resume marker BEFORE the billed turn. If the caller's persist
  // fails, archive the un-sent (unbilled) session and fail — never start a
  // billed turn we can't track.
  if (opts.onSessionCreated) {
    try {
      await opts.onSessionCreated(sessionId);
    } catch (err) {
      await archiveQuietly(getClient(), sessionId);
      throw toAgentError(err, "Failed to persist agent session marker");
    }
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const messages: string[] = [];

  try {
    // Open the stream FIRST — only events emitted after the stream opens are
    // delivered — then send the goal as a single user.message.
    const stream = await client.beta.sessions.events.stream(sessionId, undefined, {
      signal: controller.signal,
    });
    await client.beta.sessions.events.send(sessionId, {
      events: [
        { type: "user.message", content: [{ type: "text", text: userMessage }] },
      ],
    });

    let idleReason: string | undefined;
    for await (const event of stream as AsyncIterable<AnyEvent>) {
      if (event.type === "agent.message") {
        messages.push(messageText(event));
        continue;
      }
      if (event.type === "session.error") {
        // The server auto-recovers a `retrying` error — keep reading rather than
        // aborting a turn it intends to finish. Only `exhausted`/`terminal` (or
        // an unknown shape) is a real failure.
        const retry = (event.error as { retry_status?: { type?: string } } | undefined)
          ?.retry_status?.type;
        if (retry === "retrying") continue;
        const msg =
          (event.error as { message?: string } | undefined)?.message ??
          "Agent session error";
        throw new AgentError(msg, 502, msg);
      }
      if (event.type === "session.status_idle") {
        // Terminal signal. Only `end_turn` means the agent finished its turn with
        // usable output; `requires_action` (awaiting input) and `retries_exhausted`
        // (gave up) leave partial/no output we must not treat as the answer.
        idleReason = (event.stop_reason as { type?: string } | undefined)?.type;
        stream.controller.abort();
        break;
      }
    }
    if (idleReason && idleReason !== "end_turn") {
      throw new AgentError(
        `Agent ended without completing its turn (stop_reason=${idleReason})`,
        502,
      );
    }
  } catch (err) {
    await archiveQuietly(client, sessionId);
    if (controller.signal.aborted && !(err instanceof AgentError)) {
      throw new AgentError(`Agent session timed out after ${timeoutMs}ms`, 504);
    }
    throw toAgentError(err, "Agent session failed");
  } finally {
    clearTimeout(timer);
  }

  return { output: pickOutput(messages), sessionId };
}

/**
 * Run an agent expecting a JSON response. Parses the chosen output as JSON
 * (unwrapping a ```json``` fence), wrapping non-object JSON as `{ raw }` and
 * throwing `AgentError` on empty / unparseable output.
 */
export async function runAgentJson(
  agentId: string,
  environmentId: string,
  userMessage: string,
  opts: AgentCallOpts = {},
): Promise<Record<string, unknown>> {
  const result = await runAgentSession(agentId, environmentId, userMessage, opts);
  return parseJsonResponse(result.output);
}

/**
 * Outcome of a crash-resume harvest:
 *  - `completed`: the prior session finished (end_turn) with usable output — use it.
 *  - `running`: the prior session is still in progress — the caller must DEFER
 *    (leave the marker, retry next tick), NOT create a second billed session.
 *  - `unavailable`: gone / terminated / ended without usable output — the caller
 *    runs a fresh session.
 */
export type HarvestResult =
  | { state: "completed"; output: Record<string, unknown> }
  | { state: "running" }
  | { state: "unavailable" };

/**
 * Crash-resume harvest: given a previously-created session id, decide whether it
 * already produced usable output, is still running, or is unavailable — WITHOUT
 * creating a new session or sending a new (billed) turn. Distinguishing `running`
 * matters: returning "no result" for a still-running session would make the
 * caller fork a second billed session (the timeout window can equal the cron
 * re-claim window). Only an `idle` session that ended with `stop_reason=end_turn`
 * and parseable output counts as completed. `events.list` defaults to
 * chronological (`asc`); `pickOutput` seeks newest-first regardless.
 */
export async function harvestAgentSession(
  sessionId: string,
): Promise<HarvestResult> {
  const client = getClient();
  let status: string | undefined;
  try {
    const session = await client.beta.sessions.retrieve(sessionId);
    status = (session as { status?: string }).status;
  } catch (err) {
    console.warn(`harvestAgentSession: retrieve failed for ${sessionId}:`, err);
    return { state: "unavailable" };
  }
  if (status === "running" || status === "rescheduling") return { state: "running" };
  if (status !== "idle") return { state: "unavailable" }; // terminated / unknown

  try {
    const messages: string[] = [];
    let idleReason: string | undefined;
    for await (const event of client.beta.sessions.events.list(
      sessionId,
    ) as AsyncIterable<AnyEvent>) {
      if (event.type === "agent.message") messages.push(messageText(event));
      else if (event.type === "session.status_idle") {
        idleReason = (event.stop_reason as { type?: string } | undefined)?.type;
      }
    }
    // Only accept a turn that ended naturally; requires_action/retries_exhausted
    // leave partial output we must not send.
    if (idleReason && idleReason !== "end_turn") return { state: "unavailable" };
    const output = pickOutput(messages);
    if (!output.trim()) return { state: "unavailable" };
    return { state: "completed", output: parseJsonResponse(output) };
  } catch (err) {
    console.warn(`harvestAgentSession: failed to harvest ${sessionId}:`, err);
    return { state: "unavailable" };
  }
}

/**
 * Generate email content for a target via the agent. The agent decides what to
 * produce — we describe the target (allowlist-sanitized) and the content type.
 */
export async function generateContent(
  agentId: string,
  environmentId: string,
  target: Record<string, unknown>,
  contentType: string,
  opts: AgentCallOpts = {},
): Promise<Record<string, unknown>> {
  const message =
    `Generate ${contentType} email content for this target.\n\n` +
    `${formatTargetForPrompt(target)}\n\n` +
    `Respond with JSON containing "subject" and "body" fields. ` +
    `Optionally include a "confidence_score" between 0 and 1.`;
  return runAgentJson(agentId, environmentId, message, opts);
}

// ---------------------------------------------------------------------------
// Observability / config surface used by the settings routes (app/api/v1/agent/*).
// Kept here so all SDK contact stays in one module (Risk R-D).
// ---------------------------------------------------------------------------

export interface AgentSessionSummary {
  id: string;
  status: string;
  created_at: string;
  usage?: unknown;
}

/** List the agent's recent sessions (newest first — `sessions.list` defaults to
 * `desc`). Scoped to the org's `agentId`. */
export async function listAgentSessions(
  agentId: string,
  opts: { limit?: number } = {},
): Promise<AgentSessionSummary[]> {
  const client = getClient();
  const limit = opts.limit ?? 50;
  const out: AgentSessionSummary[] = [];
  try {
    for await (const s of client.beta.sessions.list({ agent_id: agentId })) {
      const session = s as { id: string; status: string; created_at: string; usage?: unknown };
      out.push({
        id: session.id,
        status: session.status,
        created_at: session.created_at,
        usage: session.usage,
      });
      if (out.length >= limit) break;
    }
  } catch (err) {
    throw toAgentError(err, "Failed to list agent sessions");
  }
  return out;
}

/**
 * Return a session's event timeline — but ONLY if the session belongs to this
 * org's agent. Because all orgs share one ANTHROPIC_API_KEY, the API would
 * return any session on the account; we verify ownership Envoy-side via
 * `sessions.retrieve().agent.id` and **fail closed** (404) on any mismatch or
 * missing field. `events.list` defaults to chronological (`asc`).
 */
export async function getAgentSessionEvents(
  agentId: string,
  sessionId: string,
): Promise<unknown[]> {
  const client = getClient();
  let owner: string | undefined;
  try {
    const session = await client.beta.sessions.retrieve(sessionId);
    owner = (session as { agent?: { id?: string } }).agent?.id;
  } catch {
    throw new AgentError("Session not found", 404);
  }
  if (!owner || owner !== agentId) {
    throw new AgentError("Session not found", 404);
  }
  const events: unknown[] = [];
  try {
    for await (const event of client.beta.sessions.events.list(sessionId)) {
      events.push(event);
    }
  } catch (err) {
    throw toAgentError(err, "Failed to list session events");
  }
  return events;
}

/** Read the agent's system prompt (the "instructions"). */
export async function getAgentInstructions(agentId: string): Promise<string | null> {
  const client = getClient();
  try {
    const agentDef = await client.beta.agents.retrieve(agentId);
    return (agentDef as { system?: string | null }).system ?? null;
  } catch (err) {
    throw toAgentError(err, "Failed to read agent instructions");
  }
}

/** Set the agent's system prompt. `agents.update` uses optimistic concurrency
 * (it requires the agent's current `version`), so we read it first. */
export async function updateAgentInstructions(
  agentId: string,
  system: string,
): Promise<void> {
  const client = getClient();
  try {
    const current = await client.beta.agents.retrieve(agentId);
    const version = (current as { version: number }).version;
    await client.beta.agents.update(agentId, { version, system });
  } catch (err) {
    throw toAgentError(err, "Failed to update agent instructions");
  }
}

/**
 * Content-seek extraction: scan the accumulated agent messages newest -> oldest
 * and return the first whose text parses to an object carrying `body` (or
 * `subject`). This tolerates trailing commentary and tool-result final turns
 * that a positional "last message" bet would mis-handle. Falls back to the last
 * non-empty message, then to the full concatenation.
 */
function pickOutput(messages: string[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const obj = tryParseObject(messages[i]);
    if (obj && (typeof obj.body === "string" || typeof obj.subject === "string")) {
      return messages[i];
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].trim()) return messages[i];
  }
  return messages.join("");
}

/** Non-throwing object parse used by content-seek (mirrors parseJsonResponse's
 * fence handling). Returns null for empty / non-object / unparseable text. */
function tryParseObject(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    if (trimmed.includes("```json")) {
      const start = trimmed.indexOf("```json") + 7;
      const end = trimmed.indexOf("```", start);
      if (end > start) {
        parsed = JSON.parse(trimmed.substring(start, end).trim());
      } else {
        parsed = JSON.parse(trimmed);
      }
    } else {
      parsed = JSON.parse(trimmed);
    }
  } catch {
    return null;
  }
  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>;
  }
  return null;
}

/**
 * Parse the agent's output as JSON, unwrapping a ```json``` code fence if
 * present. Returns the raw text wrapped in `{ raw }` when JSON parsed but the
 * shape wasn't an object. Throws `AgentError` on empty output or true parse
 * failure. (Transport-agnostic — ported verbatim from the Twin client.)
 */
export function parseJsonResponse(response: string): Record<string, unknown> {
  const trimmed = response.trim();
  if (!trimmed) {
    throw new AgentError("Agent returned empty output", 502);
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
    throw new AgentError(
      "Agent response was not valid JSON",
      502,
      response.slice(0, 500),
    );
  }

  if (
    parsedJson &&
    typeof parsedJson === "object" &&
    !Array.isArray(parsedJson)
  ) {
    return parsedJson as Record<string, unknown>;
  }
  return { raw: response };
}
