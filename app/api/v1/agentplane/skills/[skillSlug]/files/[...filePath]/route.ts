import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../../../../_helpers";
import { findRawSkill } from "../../../_skill-helpers";

/** GET /api/v1/agentplane/skills/:skillSlug/files/:filePath — get file content */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ skillSlug: string; filePath: string[] }> },
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse(
      { error: "Organization not configured for AgentPlane" },
      503,
    );
  }

  const { skillSlug, filePath } = await params;
  const filePathStr = filePath.join("/");

  try {
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const skills = (agent.skills ?? []) as Record<string, unknown>[];
    const found = findRawSkill(skills, skillSlug);
    if (!found) return jsonResponse({ error: "Skill not found" }, 404);

    const files = (found[1].files ?? []) as Record<string, unknown>[];
    const file = files.find((f) => f.path === filePathStr);
    if (!file) return jsonResponse({ error: "File not found" }, 404);

    return jsonResponse({ content: (file.content as string) ?? "" });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}

/** PUT /api/v1/agentplane/skills/:skillSlug/files/:filePath — save file content */
export async function PUT(
  request: Request,
  { params }: { params: Promise<{ skillSlug: string; filePath: string[] }> },
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse(
      { error: "Organization not configured for AgentPlane" },
      503,
    );
  }

  const { skillSlug, filePath } = await params;
  const filePathStr = filePath.join("/");
  const body = await request.json();
  const content = body.content as string;

  if (content === undefined) {
    return jsonResponse({ error: "content is required" }, 400);
  }

  try {
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const skills = (agent.skills ?? []) as Record<string, unknown>[];
    const found = findRawSkill(skills, skillSlug);
    if (!found) return jsonResponse({ error: "Skill not found" }, 404);

    const [idx, raw] = found;
    const files = (raw.files ?? []) as Record<string, unknown>[];
    const file = files.find((f) => f.path === filePathStr);
    if (!file) return jsonResponse({ error: "File not found" }, 404);

    file.content = content;
    skills[idx] = { ...raw, files };
    await agentplane.updateAgent(agentId, { skills });
    return new Response(null, { status: 204 });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}

/** DELETE /api/v1/agentplane/skills/:skillSlug/files/:filePath — delete file */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ skillSlug: string; filePath: string[] }> },
) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse(
      { error: "Organization not configured for AgentPlane" },
      503,
    );
  }

  const { skillSlug, filePath } = await params;
  const filePathStr = filePath.join("/");

  try {
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const skills = (agent.skills ?? []) as Record<string, unknown>[];
    const found = findRawSkill(skills, skillSlug);
    if (!found) return jsonResponse({ error: "Skill not found" }, 404);

    const [idx, raw] = found;
    const files = (raw.files ?? []) as Record<string, unknown>[];
    const newFiles = files.filter((f) => f.path !== filePathStr);
    if (newFiles.length === files.length) {
      return jsonResponse({ error: "File not found" }, 404);
    }

    skills[idx] = { ...raw, files: newFiles };
    await agentplane.updateAgent(agentId, { skills });
    return new Response(null, { status: 204 });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
