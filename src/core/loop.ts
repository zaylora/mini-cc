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
import { createAgentMetrics, type State } from "@/core/state.js";
import type { HookBus } from "@/hooks/bus.js";
import { noopTelemetry } from "@/observability/noop.js";
import type { Telemetry, TelemetryObservation } from "@/observability/types.js";
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
  telemetry?: Telemetry;
}

export async function agentLoop(
  state: State,
  options: AgentLoopOptions = {},
): Promise<void> {
  const telemetry = options.telemetry ?? noopTelemetry;
  return telemetry.observe("mini-cc-agent", {
    asType: "agent",
    input: latestUserInput(state),
    metadata: {
      depth: state.depth,
      workspace: process.cwd(),
      modelId: getModelId(),
    },
  }, async (agent) => {
    await runAgentLoop(state, options, telemetry);
    agent.update({
      output: latestAssistantText(state),
      metadata: { ...state.metrics },
    });
  });
}

async function runAgentLoop(
  state: State,
  options: AgentLoopOptions,
  telemetry: Telemetry,
): Promise<void> {
  const maxSteps = options.maxSteps ?? MAX_STEPS;
  const maxStopRespawns = options.maxStopRespawns ?? 1;
  state.metrics = createAgentMetrics();
  const skills = options.skills ?? await scanSkills();
  const runtime = createRuntimeTools({
    state,
    skills,
    spawnSubagent: (description) =>
      spawnSubagent(
        description,
        state.depth,
        { ...options, skills, telemetry },
        agentLoop,
      ),
  });
  const promptAssembler = createPromptAssembler(skills);
  const contextManager = createContextManager({
    summarize: (messages) => summarizeMessages(state, messages, telemetry),
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
      telemetry,
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
      onStreamInterrupted:
        state.depth === 0
          ? (reason) => options.events?.emit("stream-interrupted", {
            reason,
            depth: state.depth,
          })
          : undefined,
    });
    options.events?.emit("context-usage", {
      inputTokens: state.lastInputTokens,
      depth: state.depth,
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
      results.push(await telemetry.observe(toolUse.name, {
        asType: "tool",
        input: toolUse.input,
        metadata: { toolUseId: toolUse.id, depth: state.depth },
      }, (tool) => executeToolUse(state, options, runtime, toolUse, tool)));
    }
    state.messages.push({
      role: "user",
      content: results as ContentBlockParam[],
    });
  }

  throw new MaxStepsExceededError(maxSteps);
}

async function executeToolUse(
  state: State,
  options: AgentLoopOptions,
  runtime: ReturnType<typeof createRuntimeTools>,
  toolUse: ToolUseBlock,
  tool: TelemetryObservation,
): Promise<ToolResultBlockParam> {
  const startedAt = performance.now();
  let output: string | undefined;
  let isError = false;
  state.metrics.toolCalls += 1;

  try {
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
      isError = true;
      output = preToolUse.reason;
      emitToolEnd(options, state, toolUse, output, true);
      return blockedResult(toolUse.id, output);
    }
    if (preToolUse?.action === "ask") {
      const allowed = await options.confirm?.(preToolUse.message);
      if (!allowed) {
        isError = true;
        output = "权限被拒：用户未批准";
        emitToolEnd(options, state, toolUse, output, true);
        return blockedResult(toolUse.id, output);
      }
    }

    try {
      const result = await runtime.dispatch(toolUse.name, toolUse.input);
      const postToolUse = await options.hooks?.trigger("PostToolUse", {
        toolName: toolUse.name,
        input: toolUse.input,
        result,
      });
      output = postToolUse?.action === "inject"
        ? `${result}\n${postToolUse.context}`
        : result;
      emitToolEnd(options, state, toolUse, output, false);
      if (toolUse.name === "todo_write") {
        options.events?.emit("todo-changed", {
          todos: state.todos,
          depth: state.depth,
        });
      }
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: output,
      };
    } catch (error) {
      isError = true;
      output = errorMessage(error);
      emitToolEnd(options, state, toolUse, output, true);
      return {
        type: "tool_result",
        tool_use_id: toolUse.id,
        content: output,
        is_error: true,
      };
    }
  } catch (error) {
    isError = true;
    output = errorMessage(error);
    throw error;
  } finally {
    const durationMs = Math.max(0, performance.now() - startedAt);
    state.metrics.toolDurationMs += durationMs;
    if (isError) state.metrics.toolErrors += 1;
    tool.update({
      output,
      level: isError ? "ERROR" : "DEFAULT",
      statusMessage: isError ? output : undefined,
      metadata: { isError, durationMs },
    });
  }
}

function emitToolEnd(
  options: AgentLoopOptions,
  state: State,
  toolUse: ToolUseBlock,
  result: string,
  isError: boolean,
): void {
  options.events?.emit("tool-end", {
    id: toolUse.id,
    toolName: toolUse.name,
    result,
    isError,
    depth: state.depth,
  });
}

function latestUserInput(state: State): unknown {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message?.role === "user") return message.content;
  }
  return undefined;
}

function latestAssistantText(state: State): string {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function blockedResult(toolUseId: string, reason: string): ToolResultBlockParam {
  return {
    type: "tool_result",
    tool_use_id: toolUseId,
    content: reason,
    is_error: true,
  };
}
