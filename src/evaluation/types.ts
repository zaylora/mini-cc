import type { Todo } from "@/core/state.js";

export type AssertionSpec =
  | { type: "file_exists"; path: string }
  | { type: "file_not_exists"; path: string }
  | { type: "file_contains"; path: string; text: string }
  | { type: "file_not_contains"; path: string; text: string }
  | { type: "command_succeeds"; command: string }
  | { type: "final_contains"; text: string }
  | { type: "final_not_contains"; text: string }
  | { type: "todos_completed" };

export interface AssertionResult {
  spec: AssertionSpec;
  passed: boolean;
  message: string;
  durationMs: number;
  actual?: unknown;
}

export interface AssertionContext {
  finalOutput: string;
  todos: Todo[];
}

export interface EvalWorkspace {
  path: string;
  cleanup(): Promise<void>;
}

export interface EvalCase {
  id: string;
  name: string;
  prompt: string;
  files: Record<string, string>;
  assertions: AssertionSpec[];
  objective: string;
}

export interface JudgeDimension {
  score: number;
  reason: string;
}

export interface JudgeResult {
  accuracy: JudgeDimension;
  relevance: JudgeDimension;
  completeness: JudgeDimension;
  changeDiscipline: JudgeDimension;
}
