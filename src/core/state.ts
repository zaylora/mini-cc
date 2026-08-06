import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { join } from "node:path";
import { getModelId } from "@/config.js";
import { maxOutputTokensFor } from "@/core/modelLimits.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

export interface AgentMetrics {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
  modelDurationMs: number;
  firstTokenLatenciesMs: number[];
  toolCalls: number;
  toolErrors: number;
  toolDurationMs: number;
  retries: number;
}

export interface State {
  messages: MessageParam[];
  steps: number;
  stopRespawnCount: number;
  todos: Todo[];
  depth: number;
  workspace: string;
  enabledTools: string[];
  memoryPath: string;
  modelId: string;
  maxTokens: number;
  lastInputTokens: number;
  consecutive529: number;
  compactFailures: number;
  recoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
  metrics: AgentMetrics;
}

export function createAgentMetrics(): AgentMetrics {
  return {
    inputTokens: 0,
    outputTokens: 0,
    modelCalls: 0,
    modelDurationMs: 0,
    firstTokenLatenciesMs: [],
    toolCalls: 0,
    toolErrors: 0,
    toolDurationMs: 0,
    retries: 0,
  };
}

export function createState(depth = 0): State {
  const workspace = process.cwd();
  const modelId = getModelId();
  return {
    messages: [],
    steps: 0,
    stopRespawnCount: 0,
    todos: [],
    depth,
    workspace,
    enabledTools: [],
    memoryPath: join(workspace, ".memory", "MEMORY.md"),
    modelId,
    maxTokens: maxOutputTokensFor(modelId),
    lastInputTokens: 0,
    consecutive529: 0,
    compactFailures: 0,
    recoveryCount: 0,
    hasAttemptedReactiveCompact: false,
    metrics: createAgentMetrics(),
  };
}
