import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";

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
}

export function createState(depth = 0): State {
  return { messages: [], steps: 0, stopRespawnCount: 0, todos: [], depth };
}
