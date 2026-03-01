import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as outbox from "@/lib/queries/outbox";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const stats = await outbox.getStats(auth.tenantId);
  return jsonResponse(stats);
}
