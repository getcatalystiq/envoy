import { jsonResponse } from "@/lib/utils";
import * as targets from "@/lib/queries/targets";
import * as outbox from "@/lib/queries/outbox";
import { generateContent } from "@/lib/twin";
import { withTwinAgent } from "../../twin/_helpers";

export async function POST(request: Request) {
  return withTwinAgent(request, async ({ agentId, apiKey, tenantId }) => {
    const body = await request.json();
    const { target_id, content_type, channel, priority } = body;

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

    const result = await generateContent(agentId, target, content_type, { apiKey });
    const confidenceScore = result.confidence_score as number | undefined;

    const outboxItem = await outbox.create(
      tenantId,
      target_id,
      channel ?? "email",
      (result.body as string) ?? (result.raw as string) ?? "",
      {
        subject: result.subject as string | undefined,
        confidenceScore,
        priority,
      },
    );

    return jsonResponse(outboxItem, 201);
  });
}
