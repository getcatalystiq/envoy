/** Parse a folder-based skill into {name, slug, description, prompt}. */
export function parseSkill(raw: Record<string, unknown>): Record<string, unknown> {
  const folder = (raw.folder as string) ?? "";
  const result: Record<string, unknown> = {
    slug: folder,
    name: folder,
    description: null,
    prompt: "",
  };

  const files = (raw.files ?? []) as Record<string, unknown>[];
  const skillMd = files.find((f) => f.path === "SKILL.md");
  if (!skillMd?.content) return result;

  const content = skillMd.content as string;
  if (content.startsWith("---")) {
    const marker = content.indexOf("---", 3);
    if (marker > 0) {
      const frontmatter = content.slice(3, marker);
      for (const line of frontmatter.trim().split("\n")) {
        if (line.startsWith("name:")) {
          result.name = line.slice(5).trim();
        } else if (line.startsWith("description:")) {
          result.description = line.slice(12).trim();
        }
      }
      result.prompt = content.slice(marker + 3).trim();
    } else {
      result.prompt = content;
    }
  } else {
    result.prompt = content;
  }

  return result;
}

/** Build SKILL.md content from structured fields. */
export function buildSkillMd(
  name: string,
  description: string | null,
  prompt: string,
): string {
  const lines = ["---", `name: ${name}`];
  if (description) lines.push(`description: ${description}`);
  lines.push("---", "", prompt);
  return lines.join("\n");
}

/** Find a raw skill by folder name. Returns [index, skill] or null. */
export function findRawSkill(
  skills: Record<string, unknown>[],
  folder: string,
): [number, Record<string, unknown>] | null {
  for (let i = 0; i < skills.length; i++) {
    if (skills[i].folder === folder) return [i, skills[i]];
  }
  return null;
}
