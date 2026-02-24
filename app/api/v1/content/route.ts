import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as content from "@/lib/queries/content";
import { wrapEmailBody } from "@/lib/email";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const contentType = url.searchParams.get("content_type") ?? undefined;
  const channel = url.searchParams.get("channel") ?? undefined;
  const targetTypeId = url.searchParams.get("target_type_id") ?? undefined;
  const segmentId = url.searchParams.get("segment_id") ?? undefined;
  const lifecycleStageStr = url.searchParams.get("lifecycle_stage");
  const lifecycleStage = lifecycleStageStr != null ? Number(lifecycleStageStr) : undefined;
  const status = url.searchParams.get("status") ?? undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const items = await content.getAll(auth.tenantId, {
    contentType,
    channel,
    targetTypeId,
    segmentId,
    lifecycleStage,
    status,
    limit,
    offset,
  });

  return jsonResponse({ items, total: items.length, limit, offset });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { name, content_type, channel, subject, body: emailBody, target_type_id, segment_id, lifecycle_stage } = body;

  if (!name || !content_type) {
    return jsonResponse({ error: "name and content_type are required" }, 400);
  }

  const row = await content.create(auth.tenantId, {
    name,
    contentType: content_type,
    channel,
    subject,
    body: emailBody ? wrapEmailBody(emailBody) : emailBody,
    targetTypeId: target_type_id,
    segmentId: segment_id,
    lifecycleStage: lifecycle_stage,
  });

  return jsonResponse(row, 201);
}
