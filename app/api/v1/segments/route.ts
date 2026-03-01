import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as segments from "@/lib/queries/segments";
import * as targetTypes from "@/lib/queries/target-types";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const targetTypeId = url.searchParams.get("target_type_id") ?? undefined;

  const items = await segments.getAll(auth.tenantId, { targetTypeId });
  return jsonResponse(items);
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { target_type_id, name, description, pain_points, objections } = body;

  if (!target_type_id || !name) {
    return jsonResponse({ error: "target_type_id and name are required" }, 400);
  }

  const targetType = await targetTypes.getById(auth.tenantId, target_type_id);
  if (!targetType) {
    return jsonResponse({ error: "Target type not found" }, 400);
  }

  const existing = await segments.getByName(auth.tenantId, target_type_id, name);
  if (existing) {
    return jsonResponse(
      { error: `Segment with name '${name}' already exists for this target type` },
      400
    );
  }

  const segment = await segments.create(auth.tenantId, {
    targetTypeId: target_type_id,
    name,
    description,
    painPoints: pain_points,
    objections,
  });

  return jsonResponse(segment, 201);
}
