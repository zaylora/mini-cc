import type {
  ContentBlockParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { MAX_STEPS, getModelId } from "@/config.js";
import { createContextManager } from "@/context/manager.js";
import type { AgentEvents } from "@/core/events.js";
import { callModelWithRecovery, summarizeMessages } from "@/core/llm.js";
import { maxOutputTokensFor } from "@/core/modelLimits.js";
import { createRuntimeTools } from "@/core/runtime.js";
import type { State } from "@/core/state.js";
import type { HookBus } from "@/hooks/bus.js";
import { createPromptAssembler } from "@/prompt/assembler.js";
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
  events?: AgentEvents;
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
  const promptAssembler = createPromptAssembler(skills);
  const contextManager = createContextManager({
    summarize: (messages) => summarizeMessages(state, messages),
  });
  state.steps = 0;
  state.stopRespawnCount = 0;
  state.enabledTools = runtime.definitions.map((tool) => tool.name);
  state.workspace = process.cwd();
  state.modelId = getModelId();
  state.maxTokens = maxOutputTokensFor(state.modelId);
  state.consecutive529 = 0;
  state.recoveryCount = 0;
  state.hasAttemptedReactiveCompact = false;

  while (state.steps < maxSteps) {
    state.steps += 1;
    options.events?.emit("step-start", { step: state.steps, depth: state.depth });
    const system = await promptAssembler.get(state);
    const response = await callModelWithRecovery(state, {
      system,
      tools: runtime.definitions,
      beforeRequest: (currentState) => contextManager.manage(currentState),
      reactiveCompact: (currentState) => contextManager.reactiveCompact(currentState),
      fallbackModelId: process.env.FALLBACK_MODEL_ID,
      onTextDelta:
        state.depth === 0
          ? (text) => options.events?.emit("assistant-delta", { text, depth: state.depth })
          : undefined,
      onStreamFlush:
        state.depth === 0
          ? () => options.events?.emit("assistant-flush", { depth: state.depth })
          : undefined,
    });
    state.messages.push({ role: "assistant", content: response.content });
    const assistantText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (assistantText && state.depth > 0) {
      options.events?.emit("assistant-message", {
        text: assistantText,
        depth: state.depth,
      });
    }

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
      options.events?.emit("tool-start", {
        id: toolUse.id,
        toolName: toolUse.name,
        input: toolUse.input,
        depth: state.depth,
      });

      const preToolUse = await options.hooks?.trigger("PreToolUse", {
        toolName: toolUse.name,
        input: toolUse.input,
      });
      if (preToolUse?.action === "block") {
        results.push(blockedResult(toolUse.id, preToolUse.reason));
        options.events?.emit("tool-end", {
          id: toolUse.id,
          toolName: toolUse.name,
          result: preToolUse.reason,
          isError: true,
          depth: state.depth,
        });
        continue;
      }
      if (preToolUse?.action === "ask") {
        const allowed = await options.confirm?.(preToolUse.message);
        if (!allowed) {
          const reason = "权限被拒：用户未批准";
          results.push(blockedResult(toolUse.id, reason));
          options.events?.emit("tool-end", {
            id: toolUse.id,
            toolName: toolUse.name,
            result: reason,
            isError: true,
            depth: state.depth,
          });
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
        const content =
          postToolUse?.action === "inject"
            ? `${result}\n${postToolUse.context}`
            : result;
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content,
        });
        options.events?.emit("tool-end", {
          id: toolUse.id,
          toolName: toolUse.name,
          result: content,
          isError: false,
          depth: state.depth,
        });
        if (toolUse.name === "todo_write") {
          options.events?.emit("todo-changed", {
            todos: state.todos,
            depth: state.depth,
          });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: message,
          is_error: true,
        });
        options.events?.emit("tool-end", {
          id: toolUse.id,
          toolName: toolUse.name,
          result: message,
          isError: true,
          depth: state.depth,
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
