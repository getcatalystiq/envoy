import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as sequences from "@/lib/queries/sequences";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const existing = await sequences.getById(auth.tenantId, id);
  if (!existing) {
    return jsonResponse({ detail: "Sequence not found" }, 404);
  }

  const sequence = await sequences.update(auth.tenantId, id, { status: "archived" });
  return jsonResponse({ ...sequence, steps: existing.steps ?? [] });
}
