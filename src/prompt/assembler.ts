import { readFile } from "node:fs/promises";
import type { State } from "@/core/state.js";
import { PROMPT_SECTIONS } from "@/prompt/sections.js";
import { formatSkillCatalog, type SkillRegistry } from "@/tools/skill.js";

export interface PromptAssembler {
  get(state: State): Promise<string>;
}

export function createPromptAssembler(skills: SkillRegistry): PromptAssembler {
  let lastKey: string | undefined;
  let lastPrompt: string | undefined;

  return {
    async get(state): Promise<string> {
      const memory = await readOptionalFile(state.memoryPath);
      const catalog = formatSkillCatalog(skills);
      const context = {
        depth: state.depth,
        enabledTools: state.enabledTools,
        workspace: state.workspace,
        memory,
        catalog,
      };
      const key = JSON.stringify(context);
      if (key === lastKey && lastPrompt !== undefined) return lastPrompt;

      const sections = [
        PROMPT_SECTIONS.identity,
        state.depth > 0 ? PROMPT_SECTIONS.child : PROMPT_SECTIONS.parent,
        `当前工作目录：${state.workspace}`,
      ];
      if (state.enabledTools.length > 0) {
        sections.push(`可用工具：${state.enabledTools.join(", ")}`);
      }
      if (process.platform === "win32" && state.enabledTools.includes("bash")) {
        sections.push(
          "当前 bash 工具使用 Windows PowerShell。请直接使用 PowerShell 语法，不要嵌套调用 powershell，也不要使用 find 等 Unix shell 命令。",
        );
      }
      if (catalog) {
        sections.push(`可用技能：\n${catalog}\n需要完整技能说明时调用 load_skill。`);
      }
      if (memory) sections.push(`相关记忆：\n${memory}`);

      lastKey = key;
      lastPrompt = sections.join("\n\n");
      return lastPrompt;
    },
  };
}

async function readOptionalFile(path: string): Promise<string> {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}
