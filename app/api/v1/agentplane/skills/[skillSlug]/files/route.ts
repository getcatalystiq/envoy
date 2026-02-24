import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../../../_helpers";
import { findRawSkill } from "../../_skill-helpers";

/** GET /api/v1/agentplane/skills/:skillSlug/files — list files */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ skillSlug: string }> },
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

  const { skillSlug } = await params;

  try {
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const skills = (agent.skills ?? []) as Record<string, unknown>[];
    const found = findRawSkill(skills, skillSlug);
    if (!found) return jsonResponse({ error: "Skill not found" }, 404);

    const rawFiles = (found[1].files ?? []) as Record<string, unknown>[];
    const files = rawFiles.map((f) => ({
      name: (f.path as string).split("/").pop(),
      path: f.path,
      type: "file",
      size: ((f.content as string) ?? "").length,
    }));
    return jsonResponse({ files });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}

/** POST /api/v1/agentplane/skills/:skillSlug/files — create file */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ skillSlug: string }> },
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

  const { skillSlug } = await params;
  const body = await request.json();
  const filePath = body.path as string;

  if (!filePath) {
    return jsonResponse({ error: "path is required" }, 400);
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

    if (files.some((f) => f.path === filePath)) {
      return jsonResponse({ error: "File already exists" }, 409);
    }

    files.push({ path: filePath, content: "" });
    skills[idx] = { ...raw, files };
    await agentplane.updateAgent(agentId, { skills });
    return jsonResponse({ path: filePath }, 201);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
