import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as designTemplates from "@/lib/queries/design-templates";

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const template = await designTemplates.getById(auth.tenantId, id);
  if (!template) {
    return jsonResponse({ error: "Template not found" }, 404);
  }

  return jsonResponse(template);
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const body = await request.json();
  const { name, description, builder_content, html_compiled, archived } = body;

  const template = await designTemplates.update(auth.tenantId, id, {
    name,
    description,
    builderContent: builder_content,
    htmlCompiled: html_compiled,
    archived,
  });

  if (!template) {
    return jsonResponse({ error: "Template not found" }, 404);
  }

  return jsonResponse(template);
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const { id } = await params;
  const deleted = await designTemplates.deleteTemplate(auth.tenantId, id);
  if (!deleted) {
    return jsonResponse({ error: "Template not found" }, 404);
  }

  return new Response(null, { status: 204 });
}
