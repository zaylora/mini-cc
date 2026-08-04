import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { join } from "node:path";
import { getModelId } from "@/config.js";
import { maxOutputTokensFor } from "@/core/modelLimits.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
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
  };
}
