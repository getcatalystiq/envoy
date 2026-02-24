import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as targetTypes from "@/lib/queries/target-types";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const items = await targetTypes.getAll(auth.tenantId);
  return jsonResponse(items);
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { name, description } = body;

  if (!name) {
    return jsonResponse({ error: "name is required" }, 400);
  }

  const existing = await targetTypes.getByName(auth.tenantId, name);
  if (existing) {
    return jsonResponse({ error: `Target type with name '${name}' already exists` }, 400);
  }

  const targetType = await targetTypes.create(auth.tenantId, { name, description });
  return jsonResponse(targetType, 201);
}
