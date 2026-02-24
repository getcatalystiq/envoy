import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as content from "@/lib/queries/content";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const row = await content.getById(auth.tenantId, id);
  if (!row) {
    return jsonResponse({ error: "Content not found" }, 404);
  }

  return jsonResponse(row);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const existing = await content.getById(auth.tenantId, id);
  if (!existing) {
    return jsonResponse({ error: "Content not found" }, 404);
  }

  const body = await request.json();
  const row = await content.update(auth.tenantId, id, body);
  return jsonResponse(row);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const deleted = await content.deleteContent(auth.tenantId, id);
  if (!deleted) {
    return jsonResponse({ error: "Content not found" }, 404);
  }

  return new Response(null, { status: 204 });
}
