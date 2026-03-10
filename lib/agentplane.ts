import { AgentPlane } from "@getcatalystiq/agentplane";
import { getEnv } from "@/lib/env";

export { AgentPlaneError } from "@getcatalystiq/agentplane";

export interface RunResult {
  output: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

let _client: AgentPlane | null = null;

function getClient(): AgentPlane {
  if (!_client) {
    const env = getEnv();
    _client = new AgentPlane({
      baseUrl: env.AGENTPLANE_API_URL,
      apiKey: env.AGENTPLANE_API_KEY,
    });
  }
  return _client;
}

export async function runAgent(
  agentId: string,
  prompt: string,
  opts?: { maxTurns?: number; maxBudgetUsd?: number },
): Promise<RunResult> {
  const run = await getClient().runs.createAndWait({
    agent_id: agentId,
    prompt,
    max_turns: opts?.maxTurns,
    max_budget_usd: opts?.maxBudgetUsd,
  });

  return {
    output: run.result_summary ?? "",
    metadata: {
      cost_usd: run.cost_usd,
      num_turns: run.num_turns,
      duration_ms: run.duration_ms,
    },
  };
}

export async function listRuns(
  agentId: string,
  opts?: { limit?: number; offset?: number; status?: string },
): Promise<{ runs: unknown[]; total: number }> {
  const result = await getClient().runs.list({
    agent_id: agentId,
    limit: opts?.limit ?? 50,
    offset: opts?.offset ?? 0,
    status: opts?.status as "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out" | undefined,
  });

  return { runs: result.data, total: result.data.length };
}

export async function getRun(runId: string): Promise<unknown> {
  return getClient().runs.get(runId);
}

export async function getRunTranscript(runId: string): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of getClient().runs.transcript(runId)) {
    events.push(event);
  }
  return events;
}

export async function getAgent(agentId: string): Promise<unknown> {
  return getClient().agents.get(agentId);
}

export async function updateAgent(
  agentId: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  return getClient().agents.update(agentId, data);
}

export async function listConnectors(agentId: string): Promise<unknown> {
  return getClient().agents.connectors.list(agentId);
}

export async function saveConnectorApiKey(
  agentId: string,
  toolkit: string,
  apiKey: string,
): Promise<unknown> {
  return getClient().agents.connectors.saveApiKey(agentId, {
    toolkit,
    api_key: apiKey,
  });
}

export async function initiateConnectorOauth(
  agentId: string,
  toolkit: string,
): Promise<unknown> {
  return getClient().agents.connectors.initiateOauth(agentId, toolkit);
}

export async function deleteConnector(
  agentId: string,
  toolkit: string,
): Promise<void> {
  await getClient()._request("DELETE", `/api/agents/${agentId}/connectors/${toolkit}`);
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
