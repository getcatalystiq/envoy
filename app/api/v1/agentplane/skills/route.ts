import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../_helpers";
import { parseSkill, buildSkillMd } from "./_skill-helpers";

export async function GET(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse(
      { error: "Organization not configured for AgentPlane" },
      503,
    );
  }

  try {
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const skills = (agent.skills ?? []) as Record<string, unknown>[];
    const parsed = skills.map(parseSkill);
    return jsonResponse({ skills: parsed });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}

export async function POST(request: Request) {
  const auth = await requireAdmin(request);
  if (isErrorResponse(auth)) return auth;

  const agentId = await getAgentId(auth.tenantId);
  if (!agentId) {
    return jsonResponse(
      { error: "Organization not configured for AgentPlane" },
      503,
    );
  }

  const body = await request.json();
  const { name, slug, description, prompt } = body;

  if (!name || !slug || !prompt) {
    return jsonResponse(
      { error: "name, slug, and prompt are required" },
      400,
    );
  }

  try {
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const skills = (agent.skills ?? []) as Record<string, unknown>[];

    if (skills.some((s) => s.folder === slug)) {
      return jsonResponse(
        { error: "Skill with this slug already exists" },
        409,
      );
    }

    const newSkill = {
      folder: slug,
      files: [
        {
          path: "SKILL.md",
          content: buildSkillMd(name, description ?? null, prompt),
        },
      ],
    };
    skills.push(newSkill);
    await agentplane.updateAgent(agentId, { skills });
    return jsonResponse(parseSkill(newSkill), 201);
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
