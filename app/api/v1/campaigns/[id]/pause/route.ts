import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as campaigns from "@/lib/queries/campaigns";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const campaign = await campaigns.getById(auth.tenantId, id);
  if (!campaign) {
    return jsonResponse({ error: "Campaign not found" }, 404);
  }

  if (campaign.status !== "active") {
    return jsonResponse({ error: "Can only pause active campaigns" }, 400);
  }

  const updated = await campaigns.updateStatus(auth.tenantId, id, "paused");
  return jsonResponse(updated);
}
