import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as campaigns from "@/lib/queries/campaigns";

export async function GET(
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

  return jsonResponse(campaign);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const existing = await campaigns.getById(auth.tenantId, id);
  if (!existing) {
    return jsonResponse({ error: "Campaign not found" }, 404);
  }

  if (existing.status === "active" || existing.status === "completed") {
    return jsonResponse(
      { error: `Cannot update campaign in ${existing.status} status` },
      400
    );
  }

  const body = await request.json();
  if (body.scheduled_at && typeof body.scheduled_at === "string") {
    body.scheduled_at = new Date(body.scheduled_at).toISOString();
  }

  const campaign = await campaigns.update(auth.tenantId, id, body);
  return jsonResponse(campaign);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const existing = await campaigns.getById(auth.tenantId, id);
  if (!existing) {
    return jsonResponse({ error: "Campaign not found" }, 404);
  }

  if (existing.status === "active" || existing.status === "completed") {
    return jsonResponse(
      { error: `Cannot delete campaign in ${existing.status} status` },
      400
    );
  }

  await campaigns.deleteCampaign(auth.tenantId, id);
  return new Response(null, { status: 204 });
}
