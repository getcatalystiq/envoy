import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as targets from "@/lib/queries/targets";
import * as outbox from "@/lib/queries/outbox";
import { generateContent } from "@/lib/agentplane";

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { target_id, content_type, channel, priority } = body;

  if (!target_id || !content_type) {
    return jsonResponse({ error: "target_id and content_type are required" }, 400);
  }

  const target = await targets.getById(auth.tenantId, target_id);
  if (!target) {
    return jsonResponse({ error: "Target not found" }, 404);
  }

  const result = await generateContent(auth.tenantId, target, content_type);
  const confidenceScore = result.confidence_score as number | undefined;

  const outboxItem = await outbox.create(
    auth.tenantId,
    target_id,
    channel ?? "email",
    (result.body as string) ?? (result.raw as string) ?? "",
    {
      subject: result.subject as string | undefined,
      confidenceScore,
      priority,
    }
  );

  return jsonResponse(outboxItem, 201);
}
