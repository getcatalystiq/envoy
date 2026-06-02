import { jsonResponse } from "@/lib/utils";
import { getAgentSessionEvents } from "@/lib/agent-session";
import { withAgent } from "../../_helpers";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params;
  return withAgent(request, async ({ agentId }) => {
    // Ownership is enforced inside getAgentSessionEvents (fail-closed 404 when
    // the session doesn't belong to this org's agent) — an AgentError(404) here
    // is mapped to a 404 response by withAgent.
    const events = await getAgentSessionEvents(agentId, sessionId);
    return jsonResponse({ sessionId, events });
  });
}
