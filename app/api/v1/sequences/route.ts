import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as sequences from "@/lib/queries/sequences";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const status = url.searchParams.get("status") ?? undefined;
  const targetTypeId = url.searchParams.get("target_type_id") ?? undefined;
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 100), 1), 1000);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  const items = await sequences.getAll(auth.tenantId, { status, targetTypeId, limit, offset });

  return jsonResponse({
    items,
    total: items.length,
    limit,
    offset,
  });
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { name, target_type_id, status } = body;

  if (!name) {
    return jsonResponse({ error: "name is required" }, 400);
  }

  const sequence = await sequences.create(auth.tenantId, name, {
    targetTypeId: target_type_id,
    status,
  });

  return jsonResponse({ ...sequence, steps: [] }, 201);
}
