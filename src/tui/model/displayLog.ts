import { parseBlocks, type MarkdownBlock } from "@/markdown/blocks.js";

export type DisplayEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; depth: number }
  | { kind: "assistant-block"; id: string; block: MarkdownBlock; depth: number }
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
  streamingBlocks: MarkdownBlock[];
}

export function createDisplayLog(): DisplayLog {
  return { staticEntries: [], pendingEntries: [], streamingBlocks: [] };
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
  const { blocks } = parseBlocks(payload.text, { closeAll: true });
  return appendAssistantBlocks(log, { blocks, depth: payload.depth });
}

export function appendAssistantBlocks(
  log: DisplayLog,
  payload: { blocks: MarkdownBlock[]; depth: number },
): DisplayLog {
  const newEntries: DisplayEntry[] = payload.blocks.map((block) => ({
    kind: "assistant-block",
    id: nextId(),
    block,
    depth: payload.depth,
  }));
  if (hasPendingParentTask(log, payload.depth)) {
    return {
      ...log,
      pendingEntries: [...log.pendingEntries, ...newEntries],
    };
  }
  return {
    ...log,
    staticEntries: [...log.staticEntries, ...newEntries],
  };
}

export function setStreamingBlocks(log: DisplayLog, blocks: MarkdownBlock[]): DisplayLog {
  return { ...log, streamingBlocks: blocks };
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
  const pendingEntries = [...log.pendingEntries];
  pendingEntries[index] = {
    ...target,
    result: payload.result,
    isError: payload.isError,
  };

  // 只提交队列开头连续已完成的条目。内容按事件顺序入队，嵌套调用中
  // 父工具（如 task）必然排在它派生的子工具之前，且直到子 Agent 跑完才收到
  // tool-end，因此子工具和结论会留在 pending 区等待，不会抢到父条目前面。
  let commitCount = 0;
  while (commitCount < pendingEntries.length && isSettledEntry(pendingEntries[commitCount])) {
    commitCount += 1;
  }
  if (commitCount === 0) return { ...log, pendingEntries };

  return {
    staticEntries: [...log.staticEntries, ...pendingEntries.slice(0, commitCount)],
    pendingEntries: pendingEntries.slice(commitCount),
    streamingBlocks: log.streamingBlocks,
  };
}

function hasPendingParentTask(log: DisplayLog, depth: number): boolean {
  return log.pendingEntries.some(
    (entry) =>
      entry.kind === "tool" &&
      entry.toolName === "task" &&
      entry.depth === depth - 1 &&
      entry.result === undefined,
  );
}

function isSettledEntry(entry: DisplayEntry | undefined): boolean {
  if (!entry) return false;
  return entry.kind !== "tool" || entry.result !== undefined;
}
