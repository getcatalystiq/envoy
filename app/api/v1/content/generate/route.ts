import { jsonResponse } from "@/lib/utils";
import * as targets from "@/lib/queries/targets";
import * as content from "@/lib/queries/content";
import { generateContent } from "@/lib/agent-session";
import { withAgent } from "../../agent/_helpers";

export async function POST(request: Request) {
  return withAgent(request, async ({ agentId, environmentId, tenantId }) => {
    const body = await request.json();
    const { target_id, content_type, channel } = body;

    if (!target_id || !content_type) {
      return jsonResponse(
        { error: "target_id and content_type are required" },
        400,
      );
    }

    const target = await targets.getById(tenantId, target_id);
    if (!target) {
      return jsonResponse({ error: "Target not found" }, 404);
    }

    const result = await generateContent(agentId, environmentId, target, content_type);

    const row = await content.create(tenantId, {
      name: `AI Generated - ${target.email} - ${content_type}`,
      contentType: content_type,
      channel,
      subject: result.subject as string | undefined,
      body: (result.body as string) ?? (result.raw as string) ?? "",
      targetTypeId: target.target_type_id,
      segmentId: target.segment_id,
      lifecycleStage: target.lifecycle_stage,
      status: "draft",
    });

    return jsonResponse(row);
  });
}
