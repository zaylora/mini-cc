import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

export interface SkillMeta {
  name: string;
  description: string;
}

interface Skill extends SkillMeta {
  content: string;
}

export type SkillRegistry = ReadonlyMap<string, Skill>;

export async function scanSkills(
  directory = fileURLToPath(new URL("../skills", import.meta.url)),
): Promise<SkillRegistry> {
  const registry = new Map<string, Skill>();
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectory(error)) return registry;
    throw error;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const path = join(directory, entry.name, "SKILL.md");
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error) {
      if (isMissingDirectory(error)) continue;
      throw error;
    }
    const meta = parseFrontmatter(content, entry.name);
    registry.set(meta.name, { ...meta, content });
  }

  return registry;
}

export function formatSkillCatalog(registry: SkillRegistry): string {
  return [...registry.values()]
    .map((skill) => `- ${skill.name}: ${skill.description}`)
    .join("\n");
}

export function loadSkill(registry: SkillRegistry, name: string): string {
  const skill = registry.get(name);
  if (!skill) throw new Error(`未找到技能: ${name}`);
  return skill.content;
}

function parseFrontmatter(content: string, fallbackName: string): SkillMeta {
  const lines = content.split(/\r?\n/);
  const metadata = new Map<string, string>();
  if (lines[0]?.trim() === "---") {
    for (const line of lines.slice(1)) {
      if (line.trim() === "---") break;
      const separator = line.indexOf(":");
      if (separator === -1) continue;
      metadata.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim());
    }
  }
  return {
    name: metadata.get("name") || fallbackName,
    description: metadata.get("description") || fallbackName,
  };
}

function isMissingDirectory(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
