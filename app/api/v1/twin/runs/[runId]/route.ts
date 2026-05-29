import { jsonResponse } from "@/lib/utils";
import * as twin from "@/lib/twin";
import { withTwinAgent } from "../../_helpers";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ runId: string }> },
) {
  const { runId } = await params;
  return withTwinAgent(request, async ({ agentId, apiKey }) => {
    await twin.assertRunBelongsToAgent(agentId, runId, { apiKey });
    const [run, eventsResult] = await Promise.all([
      twin.getRun(agentId, runId, { apiKey }),
      twin.listRunEvents(agentId, runId, { limit: 500, apiKey }).catch(() => ({
        events: [],
        total_count: 0,
      })),
    ]);
    if (!run) return jsonResponse({ error: "Run not found" }, 404);
    return jsonResponse({ ...run, transcript: eventsResult.events });
  });
}
