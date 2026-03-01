import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as analytics from "@/lib/queries/analytics";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const startDate = url.searchParams.get("start_date") ?? undefined;
  const endDate = url.searchParams.get("end_date") ?? undefined;
  const campaignId = url.searchParams.get("campaign_id") ?? undefined;

  const overview = await analytics.getOverview(auth.tenantId, {
    startDate,
    endDate,
    campaignId,
  });

  return jsonResponse(overview);
}
