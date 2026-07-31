export type DisplayEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; depth: number }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      input: unknown;
      depth: number;
      result?: string;
      isError?: boolean;
    }
  | { kind: "system"; text: string };

export const MAX_DISPLAY_ENTRIES = 500;

export function appendUserEntry(log: DisplayEntry[], text: string): DisplayEntry[] {
  return cap([...log, { kind: "user", text }]);
}

export function appendSystemEntry(log: DisplayEntry[], text: string): DisplayEntry[] {
  return cap([...log, { kind: "system", text }]);
}

export function appendAssistantMessage(
  log: DisplayEntry[],
  payload: { text: string; depth: number },
): DisplayEntry[] {
  return cap([...log, { kind: "assistant", text: payload.text, depth: payload.depth }]);
}

export function appendToolStart(
  log: DisplayEntry[],
  payload: { id: string; toolName: string; input: unknown; depth: number },
): DisplayEntry[] {
  return cap([
    ...log,
    {
      kind: "tool",
      id: payload.id,
      toolName: payload.toolName,
      input: payload.input,
      depth: payload.depth,
    },
  ]);
}

export function applyToolEnd(
  log: DisplayEntry[],
  payload: { id: string; result: string; isError: boolean },
): DisplayEntry[] {
  const index = log.findIndex((entry) => entry.kind === "tool" && entry.id === payload.id);
  if (index === -1) return log;
  const next = [...log];
  const target = next[index] as Extract<DisplayEntry, { kind: "tool" }>;
  next[index] = { ...target, result: payload.result, isError: payload.isError };
  return next;
}

function cap(log: DisplayEntry[]): DisplayEntry[] {
  return log.length > MAX_DISPLAY_ENTRIES ? log.slice(log.length - MAX_DISPLAY_ENTRIES) : log;
}
