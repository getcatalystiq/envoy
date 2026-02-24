import { requireAdmin, isErrorResponse } from "@/lib/admin-auth";
import { jsonResponse } from "@/lib/utils";
import * as agentplane from "@/lib/agentplane";
import { getAgentId } from "../../_helpers";
import { parseSkill, buildSkillMd, findRawSkill } from "../_skill-helpers";

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

    const parsed = parseSkill(found[1]);
    return jsonResponse({
      id: parsed.slug,
      name: parsed.name,
      slug: parsed.slug,
      description: parsed.description,
      prompt: null,
      enabled: true,
    });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}

export async function PATCH(
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

  try {
    const agent = (await agentplane.getAgent(agentId)) as Record<
      string,
      unknown
    >;
    const skills = (agent.skills ?? []) as Record<string, unknown>[];
    const found = findRawSkill(skills, skillSlug);
    if (!found) return jsonResponse({ error: "Skill not found" }, 404);

    const [idx, raw] = found;
    const parsed = parseSkill(raw);
    const name = (body.name as string) ?? (parsed.name as string);
    const desc =
      body.description !== undefined
        ? (body.description as string | null)
        : (parsed.description as string | null);
    const prompt = (body.prompt as string) ?? (parsed.prompt as string);

    const files = (raw.files ?? []) as Record<string, unknown>[];
    const newMd = buildSkillMd(name, desc, prompt);
    let updated = false;
    for (const f of files) {
      if (f.path === "SKILL.md") {
        f.content = newMd;
        updated = true;
        break;
      }
    }
    if (!updated) files.push({ path: "SKILL.md", content: newMd });

    skills[idx] = { folder: skillSlug, files };
    await agentplane.updateAgent(agentId, { skills });
    return jsonResponse(parseSkill(skills[idx]));
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}

export async function DELETE(
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
    const newSkills = skills.filter((s) => s.folder !== skillSlug);

    if (newSkills.length === skills.length) {
      return jsonResponse({ error: "Skill not found" }, 404);
    }

    await agentplane.updateAgent(agentId, { skills: newSkills });
    return new Response(null, { status: 204 });
  } catch {
    return jsonResponse({ error: "AgentPlane service unavailable" }, 503);
  }
}
