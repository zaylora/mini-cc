import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { createState, type State } from "@/core/state.js";
import type { HookBus } from "@/hooks/bus.js";
import type { SkillRegistry } from "@/tools/skill.js";

export interface SubagentOptions {
  hooks?: HookBus;
  confirm?: (message: string) => Promise<boolean>;
  maxSteps?: number;
  maxStopRespawns?: number;
  skills?: SkillRegistry;
}

type RunAgent = (state: State, options: SubagentOptions) => Promise<void>;

export async function spawnSubagent(
  description: string,
  parentDepth: number,
  options: SubagentOptions,
  runAgent: RunAgent,
): Promise<string> {
  const state = createState(parentDepth + 1);
  state.messages.push({ role: "user", content: description });
  await runAgent(state, options);

  const conclusion = extractLastAssistantText(state.messages);
  if (!conclusion) throw new Error("子 Agent 未返回文本结论");
  return conclusion;
}

function extractLastAssistantText(messages: MessageParam[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}
