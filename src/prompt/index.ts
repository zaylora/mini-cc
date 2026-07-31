import { formatSkillCatalog, type SkillRegistry } from "@/tools/skill.js";

export function buildSystemPrompt(skills: SkillRegistry, depth: number): string {
  const catalog = formatSkillCatalog(skills);
  const skillSection = catalog
    ? `\n可用技能：\n${catalog}\n需要完整技能说明时调用 load_skill。`
    : "";
  const subagentInstruction = depth > 0
    ? "\n你是子 Agent。直接完成交给你的任务，不要再次委派。"
    : "\n复杂任务先用 todo_write 规划；适合隔离处理的子任务可调用 task。";

  return `你是一个编码助手。
你可以使用工具检查和操作当前目录。先检查事实，再执行操作；完成任务后用简洁的自然语言回答。${subagentInstruction}${skillSection}`;
}
