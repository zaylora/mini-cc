import type { State, Todo, TodoStatus } from "@/core/state.js";

export const STATUS_MARKS: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: ">",
  completed: "x",
};

export async function runTodoWrite(
  state: State,
  input: unknown,
): Promise<string> {
  const todos = parseTodos(input);
  state.todos = todos;

  return [
    "当前任务：",
    ...todos.map((todo) => `[${STATUS_MARKS[todo.status]}] ${todo.content}`),
  ].join("\n");
}

function parseTodos(input: unknown): Todo[] {
  if (!isRecord(input) || !Array.isArray(input.todos)) {
    throw new Error("todos 必须是数组");
  }

  return input.todos.map((todo) => {
    if (!isRecord(todo) || typeof todo.content !== "string") {
      throw new Error("todo content 必须是字符串");
    }
    if (!isTodoStatus(todo.status)) {
      throw new Error(`无效的 todo 状态: ${String(todo.status)}`);
    }
    return { content: todo.content, status: todo.status };
  });
}

function isTodoStatus(value: unknown): value is TodoStatus {
  return value === "pending" || value === "in_progress" || value === "completed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
