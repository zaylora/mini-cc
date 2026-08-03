export type DisplayEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; depth: number }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      input: unknown;
      depth: number;
      result?: string;
      isError?: boolean;
    }
  | { kind: "system"; id: string; text: string };

export interface DisplayLog {
  staticEntries: DisplayEntry[];
  pendingEntries: DisplayEntry[];
}

export function createDisplayLog(): DisplayLog {
  return { staticEntries: [], pendingEntries: [] };
}

let nextEntryId = 0;
function nextId(): string {
  nextEntryId += 1;
  return `e${nextEntryId}`;
}

export function appendUserEntry(log: DisplayLog, text: string): DisplayLog {
  return {
    ...log,
    staticEntries: [...log.staticEntries, { kind: "user", id: nextId(), text }],
  };
}

export function appendSystemEntry(log: DisplayLog, text: string): DisplayLog {
  return {
    ...log,
    staticEntries: [...log.staticEntries, { kind: "system", id: nextId(), text }],
  };
}

export function appendAssistantMessage(
  log: DisplayLog,
  payload: { text: string; depth: number },
): DisplayLog {
  return {
    ...log,
    staticEntries: [
      ...log.staticEntries,
      { kind: "assistant", id: nextId(), text: payload.text, depth: payload.depth },
    ],
  };
}

export function appendToolStart(
  log: DisplayLog,
  payload: { id: string; toolName: string; input: unknown; depth: number },
): DisplayLog {
  return {
    ...log,
    pendingEntries: [
      ...log.pendingEntries,
      {
        kind: "tool",
        id: payload.id,
        toolName: payload.toolName,
        input: payload.input,
        depth: payload.depth,
      },
    ],
  };
}

export function applyToolEnd(
  log: DisplayLog,
  payload: { id: string; result: string; isError: boolean },
): DisplayLog {
  const index = log.pendingEntries.findIndex(
    (entry) => entry.kind === "tool" && entry.id === payload.id,
  );
  if (index === -1) return log;
  const target = log.pendingEntries[index] as Extract<DisplayEntry, { kind: "tool" }>;
  const finished: DisplayEntry = {
    ...target,
    result: payload.result,
    isError: payload.isError,
  };
  return {
    staticEntries: [...log.staticEntries, finished],
    pendingEntries: [
      ...log.pendingEntries.slice(0, index),
      ...log.pendingEntries.slice(index + 1),
    ],
  };
}
