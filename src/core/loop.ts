import type {
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { MAX_STEPS, MAX_TOKENS } from "@/config.js";
import { callModel } from "@/core/llm.js";
import { createRuntimeTools } from "@/core/runtime.js";
import type { State } from "@/core/state.js";
import type { HookBus } from "@/hooks/bus.js";
import { buildSystemPrompt } from "@/prompt/index.js";
import { scanSkills, type SkillRegistry } from "@/tools/skill.js";
import { spawnSubagent } from "@/tools/task.js";

export class MaxStepsExceededError extends Error {
  constructor(maxSteps: number) {
    super(`已达到单轮最大步数 ${maxSteps}`);
    this.name = "MaxStepsExceededError";
  }
}

export interface AgentLoopOptions {
  hooks?: HookBus;
  confirm?: (message: string) => Promise<boolean>;
  maxSteps?: number;
  maxStopRespawns?: number;
  skills?: SkillRegistry;
}

export async function agentLoop(
  state: State,
  options: AgentLoopOptions = {},
): Promise<void> {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const maxStopRespawns = options.maxStopRespawns ?? 1;
  const skills = options.skills ?? await scanSkills();
  const runtime = createRuntimeTools({
    state,
    skills,
    spawnSubagent: (description) =>
      spawnSubagent(description, state.depth, { ...options, skills }, agentLoop),
  });
  state.steps = 0;
  state.stopRespawnCount = 0;

  while (state.steps < maxSteps) {
    state.steps += 1;
    const response = await callModel(
      buildSystemPrompt(skills, state.depth),
      state.messages,
      runtime.definitions,
      MAX_TOKENS,
    );
    state.messages.push({ role: "assistant", content: response.content });

    const toolUses = response.content.filter(
      (block): block is ToolUseBlock => block.type === "tool_use",
    );
    if (toolUses.length === 0) {
      const stop = await options.hooks?.trigger("Stop", {
        turnCount: state.steps,
      });
      if (
        stop?.action === "respawn" &&
        state.stopRespawnCount < maxStopRespawns
      ) {
        state.stopRespawnCount += 1;
        state.messages.push({ role: "user", content: stop.message });
        continue;
      }
      return;
    }

    const results: ToolResultBlockParam[] = [];
    for (const toolUse of toolUses) {
      const preToolUse = await options.hooks?.trigger("PreToolUse", {
        toolName: toolUse.name,
        input: toolUse.input,
      });
      if (preToolUse?.action === "block") {
        results.push(blockedResult(toolUse.id, preToolUse.reason));
        continue;
      }
      if (preToolUse?.action === "ask") {
        const allowed = await options.confirm?.(preToolUse.message);
        if (!allowed) {
          results.push(blockedResult(toolUse.id, "权限被拒：用户未批准"));
          continue;
        }
      }

      try {
        const result = await runtime.dispatch(toolUse.name, toolUse.input);
        const postToolUse = await options.hooks?.trigger("PostToolUse", {
          toolName: toolUse.name,
          input: toolUse.input,
          result,
        });
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content:
            postToolUse?.action === "inject"
              ? `${result}\n${postToolUse.context}`
              : result,
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

  throw new MaxStepsExceededError(maxSteps);
}

function blockedResult(toolUseId: string, reason: string): ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: reason,
    is_error: true,
  };
}
