import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import { wrapEmailBody } from "@/lib/email";
import * as outbox from "@/lib/queries/outbox";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const channel = url.searchParams.get("channel") ?? undefined;
  const targetId = url.searchParams.get("target_id") ?? undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const [items, total] = await Promise.all([
    outbox.getAll(auth.tenantId, { status, channel, targetId, limit, offset }),
    outbox.count(auth.tenantId, status),
  ]);

  return jsonResponse({ items, total, limit, offset });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const {
    target_id,
    channel,
    subject,
    body: emailBody,
    confidence_score,
    priority,
    scheduled_for,
  } = body;

  if (!target_id || !channel) {
    return jsonResponse({ error: "target_id and channel are required" }, 400);
  }

  const wrappedBody = emailBody ? wrapEmailBody(emailBody) : emailBody;

  const item = await outbox.create(auth.tenantId, target_id, channel, wrappedBody, {
    subject,
    confidenceScore: confidence_score,
    priority,
    scheduledFor: scheduled_for,
    createdBy: auth.userId,
  });

  return jsonResponse(item, 201);
}
