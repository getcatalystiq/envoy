import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as designTemplates from "@/lib/queries/design-templates";

const DEFAULT_BUILDER_CONTENT = {
  root: {
    type: "EmailLayout",
    data: {
      backdropColor: "#F5F5F5",
      canvasColor: "#FFFFFF",
      textColor: "#242424",
      fontFamily: "MODERN_SANS",
      childrenIds: ["content-block"],
    },
  },
  "content-block": {
    type: "Text",
    data: {
      style: { padding: { top: 24, bottom: 24, left: 24, right: 24 } },
      props: { text: "Start writing your email here..." },
    },
  },
};

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const url = new URL(request.url);
  const includeArchived = url.searchParams.get("include_archived") === "true";

  const items = await designTemplates.getAll(auth.tenantId, { includeArchived });
  return jsonResponse(items);
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const body = await request.json();
  const { name, description, builder_content } = body;

  if (!name) {
    return jsonResponse({ error: "name is required" }, 400);
  }

  const template = await designTemplates.create(auth.tenantId, {
    name,
    description,
    builderContent: builder_content ?? DEFAULT_BUILDER_CONTENT,
  });

  return jsonResponse(template, 201);
}
