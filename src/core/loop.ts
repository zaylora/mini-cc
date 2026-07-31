import type {
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { MAX_STEPS, MAX_TOKENS } from "@/config.js";
import { callModel } from "@/core/llm.js";
import type { State } from "@/core/state.js";
import { SYSTEM_PROMPT } from "@/prompt/index.js";
import { dispatch, TOOLS } from "@/tools/registry.js";

export class MaxStepsExceededError extends Error {
  constructor(maxSteps: number) {
    super(`已达到单轮最大步数 ${maxSteps}`);
    this.name = "MaxStepsExceededError";
  }
}

export async function agentLoop(state: State): Promise<void> {
  state.steps = 0;

  while (state.steps < MAX_STEPS) {
    state.steps += 1;
    const response = await callModel(
      SYSTEM_PROMPT,
      state.messages,
      TOOLS,
      MAX_TOKENS,
    );
    state.messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) return;

    const results: ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      try {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: await dispatch(toolUse.name, toolUse.input),
        });
      } catch (error) {
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: error instanceof Error ? error.message : String(error),
          is_error: true,
        });
      }
    }
    state.messages.push({
      role: "user",
      content: results as ContentBlockParam[],
    });
  }

  throw new MaxStepsExceededError(MAX_STEPS);
}
