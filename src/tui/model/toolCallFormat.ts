export function toolLabel(toolName: string): string {
  switch (toolName) {
    case "bash":
      return "Bash";
    case "read_file":
      return "Read";
    case "write_file":
      return "Write";
    case "edit_file":
      return "Edit";
    case "glob":
      return "Glob";
    case "task":
      return "Task";
    case "load_skill":
      return "Skill";
    case "todo_write":
      return "Todo";
    default:
      return toolName;
  }
}

export function describeToolCall(toolName: string, input: unknown): string {
  if (toolName === "todo_write") {
    const todos = getInputField(input, "todos");
    return formatDescription(`${Array.isArray(todos) ? todos.length : 0} 项`);
  }

  let field: string | undefined;
  switch (toolName) {
    case "bash":
      field = "command";
      break;
    case "read_file":
    case "write_file":
    case "edit_file":
      field = "path";
      break;
    case "glob":
      field = "pattern";
      break;
    case "task":
      field = "description";
      break;
    case "load_skill":
      field = "name";
      break;
  }

  const value = field === undefined ? undefined : getInputField(input, field);
  const description = typeof value === "string" ? value : JSON.stringify(input ?? {}) ?? "{}";
  return formatDescription(description);
}

export function toolDotColor(state: {
  result?: string;
  isError?: boolean;
}): "yellow" | "green" | "red" {
  if (state.result === undefined) return "yellow";
  return state.isError === true ? "red" : "green";
}

function getInputField(input: unknown, field: string): unknown {
  if (input === null || typeof input !== "object") return undefined;
  return (input as Record<string, unknown>)[field];
}

function formatDescription(description: string): string {
  const normalized = description.replace(/\r\n|\r|\n/g, " ");
  return normalized.length > 100 ? `${normalized.slice(0, 100)}…` : normalized;
}
