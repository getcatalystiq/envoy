import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as analytics from "@/lib/queries/analytics";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const startDate = url.searchParams.get("start_date") ?? undefined;
  const endDate = url.searchParams.get("end_date") ?? undefined;

  const result = await analytics.getTimeSeries(auth.tenantId, {
    startDate,
    endDate,
  });

  return jsonResponse(result);
}
