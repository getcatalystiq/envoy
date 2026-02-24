import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as graduation from "@/lib/queries/graduation";
import { sql } from "@/lib/db";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const sourceTargetTypeId = url.searchParams.get("source_target_type_id") ?? undefined;
  const enabledStr = url.searchParams.get("enabled");
  const enabled = enabledStr != null ? enabledStr === "true" : undefined;

  const rules = await graduation.getRules(auth.tenantId, { sourceTargetTypeId, enabled });
  return jsonResponse(rules);
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const {
    source_target_type_id,
    destination_target_type_id,
    name,
    description,
    conditions,
    enabled = true,
  } = body;

  if (!source_target_type_id || !destination_target_type_id || !name || !conditions) {
    return jsonResponse(
      { error: "source_target_type_id, destination_target_type_id, name, and conditions are required" },
      400
    );
  }

  if (source_target_type_id === destination_target_type_id) {
    return jsonResponse(
      { error: "Source and destination target types must be different" },
      400
    );
  }

  // Validate both target types belong to organization
  const sourceRows = await sql`
    SELECT id FROM target_types WHERE id = ${source_target_type_id}::uuid AND organization_id = ${auth.tenantId}
  `;
  if (sourceRows.length === 0) {
    return jsonResponse({ error: "Invalid source target type" }, 400);
  }

  const destRows = await sql`
    SELECT id FROM target_types WHERE id = ${destination_target_type_id}::uuid AND organization_id = ${auth.tenantId}
  `;
  if (destRows.length === 0) {
    return jsonResponse({ error: "Invalid destination target type" }, 400);
  }

  // Check for cycles if enabling
  if (enabled) {
    const hasCycle = await graduation.checkForCycle(
      auth.tenantId,
      source_target_type_id,
      destination_target_type_id
    );
    if (hasCycle) {
      return jsonResponse(
        { error: "This rule would create a circular graduation path" },
        400
      );
    }
  }

  const rule = await graduation.createRule(
    auth.tenantId,
    source_target_type_id,
    destination_target_type_id,
    name,
    conditions,
    { description, enabled }
  );

  return jsonResponse(rule, 201);
}
