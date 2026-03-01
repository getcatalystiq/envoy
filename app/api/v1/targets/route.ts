import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as targets from "@/lib/queries/targets";
import { autoEnrollInDefaultSequences } from "@/lib/queries/sequences";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const targetTypeId = url.searchParams.get("target_type_id") ?? undefined;
  const segmentId = url.searchParams.get("segment_id") ?? undefined;
  const lifecycleStageStr = url.searchParams.get("lifecycle_stage");
  const lifecycleStage = lifecycleStageStr != null ? Number(lifecycleStageStr) : undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const [items, total] = await Promise.all([
    targets.getAll(auth.tenantId, { status, targetTypeId, segmentId, lifecycleStage, limit, offset }),
    targets.count(auth.tenantId, status),
  ]);

  return jsonResponse({ items, total, limit, offset });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { email, first_name, last_name, company, target_type_id, segment_id, lifecycle_stage, custom_fields } = body;

  if (!email) {
    return jsonResponse({ error: "email is required" }, 400);
  }

  const existing = await targets.getByEmail(auth.tenantId, email);
  if (existing) {
    return jsonResponse({ error: "Email already exists" }, 409);
  }

  const target = await targets.create(auth.tenantId, {
    email,
    firstName: first_name,
    lastName: last_name,
    company,
    targetTypeId: target_type_id,
    segmentId: segment_id,
    lifecycleStage: lifecycle_stage,
    customFields: custom_fields,
  });

  if (target.target_type_id) {
    await autoEnrollInDefaultSequences(auth.tenantId, target.id, target.target_type_id);
  }

  return jsonResponse(target, 201);
}
