import { jsonResponse } from "@/lib/utils";
import { listAgentSessions } from "@/lib/agent-session";
import { withAgent } from "../_helpers";

export async function GET(request: Request) {
  return withAgent(request, async ({ agentId }) => {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const limit = (() => {
      const n = limitRaw === null ? NaN : Number.parseInt(limitRaw, 10);
      if (!Number.isFinite(n) || n < 1) return 50;
      return Math.min(n, 200);
    })();
    const sessions = await listAgentSessions(agentId, { limit });
    return jsonResponse({ sessions });
  });
}
