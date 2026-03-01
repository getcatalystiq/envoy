import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as targetTypes from "@/lib/queries/target-types";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const targetType = await targetTypes.getById(auth.tenantId, id);
  if (!targetType) {
    return jsonResponse({ error: "Target type not found" }, 404);
  }

  const usage = await targetTypes.getUsageCount(id);
  return jsonResponse(usage);
}
