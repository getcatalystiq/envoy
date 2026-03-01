import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as campaigns from "@/lib/queries/campaigns";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; contentId: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id, contentId } = await params;
  const url = new URL(request.url);
  const position = Number(url.searchParams.get("position") ?? 0);

  const campaign = await campaigns.getById(auth.tenantId, id);
  if (!campaign) {
    return jsonResponse({ error: "Campaign not found" }, 404);
  }

  const success = await campaigns.addContent(auth.tenantId, id, contentId, position);
  if (!success) {
    return jsonResponse({ error: "Failed to add content" }, 400);
  }

  return jsonResponse({ status: "added" }, 201);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; contentId: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id, contentId } = await params;
  const removed = await campaigns.removeContent(id, contentId);
  if (!removed) {
    return jsonResponse({ error: "Content not found in campaign" }, 404);
  }

  return new Response(null, { status: 204 });
}
