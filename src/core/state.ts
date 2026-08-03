import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { join } from "node:path";
import { MAX_TOKENS, getModelId } from "@/config.js";

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
  hasEscalatedMaxTokens: boolean;
  hasAttemptedReactiveCompact: boolean;
}

export function createState(depth = 0): State {
  const workspace = process.cwd();
  return {
    messages: [],
    steps: 0,
    stopRespawnCount: 0,
    todos: [],
    depth,
    workspace,
    enabledTools: [],
    memoryPath: join(workspace, ".memory", "MEMORY.md"),
    modelId: getModelId(),
    maxTokens: MAX_TOKENS,
    lastInputTokens: 0,
    consecutive529: 0,
    compactFailures: 0,
    recoveryCount: 0,
    hasEscalatedMaxTokens: false,
    hasAttemptedReactiveCompact: false,
  };
}
