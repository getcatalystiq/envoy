import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as analytics from "@/lib/queries/analytics";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const days = Math.min(Math.max(Number(url.searchParams.get("days") ?? 30), 1), 365);
  const campaignId = url.searchParams.get("campaign_id") ?? undefined;

  const metrics = await analytics.getEngagementMetrics(auth.tenantId, {
    days,
    campaignId,
  });

  return jsonResponse({ metrics });
}
