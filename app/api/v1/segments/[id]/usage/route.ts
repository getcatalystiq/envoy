import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as segments from "@/lib/queries/segments";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const segment = await segments.getById(auth.tenantId, id);
  if (!segment) {
    return jsonResponse({ error: "Segment not found" }, 404);
  }

  const usage = await segments.getUsageCount(id);
  return jsonResponse(usage);
}
