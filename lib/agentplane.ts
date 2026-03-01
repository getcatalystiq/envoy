import { getEnv } from "@/lib/env";

const DEFAULT_TIMEOUT = 30_000;
const STREAMING_TIMEOUT = 300_000;
const MAX_BUFFER = 4 * 1024 * 1024; // 4MB safety limit

export class AgentPlaneError extends Error {
  code?: string;
  constructor(message: string, code?: string) {
    super(message);
    this.name = "AgentPlaneError";
    this.code = code;
  }
}

export interface RunResult {
  output: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

function getHeaders(): Record<string, string> {
  const env = getEnv();
  return {
    Authorization: `Bearer ${env.AGENTPLANE_API_KEY}`,
    "Content-Type": "application/json",
  };
}

function getBaseUrl(): string {
  return getEnv().AGENTPLANE_API_URL;
}

async function fetchWithRetry(
  url: string,
  init: RequestInit,
  retries = 3,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, init);
      if (response.status === 429 || response.status >= 500) {
        lastError = new Error(
          `HTTP ${response.status}: ${response.statusText}`,
        );
        if (attempt < retries - 1) {
          const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
          await new Promise((r) => setTimeout(r, delay));
          continue;
        }
      }
      return response;
    } catch (err) {
      lastError = err;
      if (attempt < retries - 1) {
        const delay = Math.min(2000 * Math.pow(2, attempt), 30000);
        await new Promise((r) => setTimeout(r, delay));
        continue;
      }
    }
  }
  throw lastError;
}

async function consumeNdjsonStream(response: Response): Promise<RunResult> {
  const body = response.body;
  if (!body) throw new AgentPlaneError("No response body");

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let result: RunResult | null = null;
  let bufferSize = 0;
  let partial = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      partial += chunk;
      bufferSize += chunk.length;

      if (bufferSize > MAX_BUFFER) {
        throw new AgentPlaneError("Response exceeded maximum buffer size");
      }

      const lines = partial.split("\n");
      // Keep the last partial line in the buffer
      partial = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(trimmed);
        } catch {
          continue; // skip malformed lines
        }

        if (event.type === "error") {
          const data = event.data as Record<string, unknown> | undefined;
          throw new AgentPlaneError(
            (data?.message as string) ?? "Unknown error",
            data?.code as string | undefined,
          );
        }

        if (event.type === "result") {
          const metadata: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(event)) {
            if (!["type", "subtype", "result", "session_id"].includes(k)) {
              metadata[k] = v;
            }
          }
          result = {
            output: (event.result as string) ?? "",
            sessionId: event.session_id as string | undefined,
            metadata,
          };
          // Continue draining to keep connection clean
        }
      }
    }

    // Process any remaining partial line
    if (partial.trim()) {
      try {
        const event = JSON.parse(partial.trim());
        if (event.type === "result" && !result) {
          const metadata: Record<string, unknown> = {};
          for (const [k, v] of Object.entries(event)) {
            if (!["type", "subtype", "result", "session_id"].includes(k)) {
              metadata[k] = v;
            }
          }
          result = {
            output: (event.result as string) ?? "",
            sessionId: event.session_id as string | undefined,
            metadata,
          };
        }
      } catch {
        // ignore malformed trailing data
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!result) {
    throw new AgentPlaneError("Stream ended without result event");
  }
  return result;
}

export async function runAgent(
  agentId: string,
  prompt: string,
  opts?: { maxTurns?: number; maxBudgetUsd?: number },
): Promise<RunResult> {
  const body: Record<string, unknown> = { prompt, agent_id: agentId };
  if (opts?.maxTurns != null) body.max_turns = opts.maxTurns;
  if (opts?.maxBudgetUsd != null) body.max_budget_usd = opts.maxBudgetUsd;

  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/runs`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(STREAMING_TIMEOUT),
    },
    3,
  );

  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new AgentPlaneError(
      `HTTP ${response.status}: ${text || response.statusText}`,
    );
  }

  return consumeNdjsonStream(response);
}

export async function listRuns(
  agentId: string,
  opts?: { limit?: number; offset?: number; status?: string },
): Promise<{ runs: unknown[]; total: number }> {
  const params = new URLSearchParams();
  params.set("limit", String(opts?.limit ?? 50));
  params.set("offset", String(opts?.offset ?? 0));
  if (opts?.status) params.set("status", opts.status);

  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/agents/${agentId}/runs?${params}`,
    {
      method: "GET",
      headers: getHeaders(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }

  const result = await response.json();
  if (!result) return { runs: [], total: 0 };
  const data = result.data ?? [];
  return { runs: data, total: data.length };
}

export async function getRun(runId: string): Promise<unknown> {
  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/runs/${runId}`,
    {
      method: "GET",
      headers: getHeaders(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function getRunTranscript(runId: string): Promise<unknown[]> {
  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/runs/${runId}/transcript`,
    {
      method: "GET",
      headers: getHeaders(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }

  const text = await response.text();
  const entries: unknown[] = [];
  for (const line of text.trim().split("\n")) {
    const trimmed = line.trim();
    if (trimmed) entries.push(JSON.parse(trimmed));
  }
  return entries;
}

export async function getAgent(agentId: string): Promise<unknown> {
  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/agents/${agentId}`,
    {
      method: "GET",
      headers: getHeaders(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function updateAgent(
  agentId: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/agents/${agentId}`,
    {
      method: "PUT",
      headers: getHeaders(),
      body: JSON.stringify(data),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function listConnectors(agentId: string): Promise<unknown> {
  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/agents/${agentId}/connectors`,
    {
      method: "GET",
      headers: getHeaders(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function saveConnectorApiKey(
  agentId: string,
  toolkit: string,
  apiKey: string,
): Promise<unknown> {
  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/agents/${agentId}/connectors`,
    {
      method: "POST",
      headers: getHeaders(),
      body: JSON.stringify({ toolkit, api_key: apiKey }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function initiateConnectorOauth(
  agentId: string,
  toolkit: string,
): Promise<unknown> {
  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/agents/${agentId}/connectors/${toolkit}/initiate-oauth`,
    {
      method: "POST",
      headers: getHeaders(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json();
}

export async function deleteConnector(
  agentId: string,
  toolkit: string,
): Promise<void> {
  const response = await fetchWithRetry(
    `${getBaseUrl()}/api/agents/${agentId}/connectors/${toolkit}`,
    {
      method: "DELETE",
      headers: getHeaders(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT),
    },
  );

  if (!response.ok) {
    throw new AgentPlaneError(`HTTP ${response.status}: ${response.statusText}`);
  }
}

export async function invokeSkill(
  agentId: string,
  skillName: string,
  context: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const prompt = `use skill ${skillName}\n\nContext:\n${JSON.stringify(context, null, 2)}`;
  const result = await runAgent(agentId, prompt);
  return parseSkillResponse(result.output);
}

export async function generateContent(
  agentId: string,
  target: Record<string, unknown>,
  contentType: string,
): Promise<Record<string, unknown>> {
  return invokeSkill(agentId, "envoy-content-generation", {
    target,
    content_type: contentType,
  });
}

function parseSkillResponse(response: string): Record<string, unknown> {
  try {
    if (response.includes("```json")) {
      const start = response.indexOf("```json") + 7;
      const end = response.indexOf("```", start);
      return JSON.parse(response.substring(start, end).trim());
    }
    return JSON.parse(response);
  } catch {
    return { raw: response };
  }
}
