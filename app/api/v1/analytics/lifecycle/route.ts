import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as analytics from "@/lib/queries/analytics";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const targetTypeId = url.searchParams.get("target_type_id") ?? undefined;

  const result = await analytics.getLifecycleDistribution(
    auth.tenantId,
    targetTypeId
  );

  return jsonResponse(result);
}
