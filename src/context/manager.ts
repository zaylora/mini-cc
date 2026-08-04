import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
import type { State } from "@/core/state.js";
import {
  persistedOutputPath,
  persistedOutputReference,
  persistToolResult,
  writeTranscript,
} from "@/context/persist.js";

const MICRO_MIN_LENGTH = 120;
const MICRO_INPUT_PREVIEW = 120;
const CHARACTERS_PER_TOKEN = 3;
/** 落盘引用除预览外的固定开销（标签 + 相对路径）。 */
const PERSIST_REFERENCE_OVERHEAD = 160;

export interface ContextManager {
  manage(state: State): Promise<void>;
  reactiveCompact(state: State): Promise<void>;
}

export interface ContextManagerOptions {
  root?: string;
  maxMessages?: number;
  keepHeadMessages?: number;
  keepRecentToolResults?: number;
  toolResultBudget?: number;
  toolResultPreview?: number;
  toolResultPersistThreshold?: number;
  microCompactThreshold?: number;
  compactThreshold?: number;
  reactiveTailMessages?: number;
  maxCompactFailures?: number;
  summarize?: (messages: MessageParam[]) => Promise<string>;
}

export function createContextManager(
  options: ContextManagerOptions = {},
): ContextManager {
  const maxMessages = options.maxMessages ?? 50;
  const keepHeadMessages = options.keepHeadMessages ?? 3;
  const keepRecentToolResults = options.keepRecentToolResults ?? 25;
  const toolResultBudget = options.toolResultBudget ?? 200_000;
  const toolResultPreview = options.toolResultPreview ?? 2_000;
  const toolResultPersistThreshold =
    options.toolResultPersistThreshold ?? 30_000;
  const microCompactThreshold = options.microCompactThreshold ?? 90_000;
  const compactThreshold = options.compactThreshold ?? 150_000;
  const reactiveTailMessages = options.reactiveTailMessages ?? 5;
  const maxCompactFailures = options.maxCompactFailures ?? 3;

  return {
    async manage(state): Promise<void> {
      const root = options.root ?? state.workspace;
      await applyToolResultBudget(
        state.messages,
        root,
        toolResultBudget,
        toolResultPreview,
        toolResultPersistThreshold,
      );
      state.messages = snipMessages(
        state.messages,
        maxMessages,
        keepHeadMessages,
      );
      if (contextTokens(state) > microCompactThreshold) {
        microCompact(state.messages, keepRecentToolResults);
      }

      if (
        contextTokens(state) <= compactThreshold ||
        state.compactFailures >= maxCompactFailures
      ) {
        return;
      }
      try {
        state.messages = await compactHistory(
          state.messages,
          root,
          requireSummarizer(options.summarize),
          "Compacted",
        );
        state.compactFailures = 0;
      } catch {
        state.compactFailures += 1;
      }
    },

    async reactiveCompact(state): Promise<void> {
      const root = options.root ?? state.workspace;
      let tailStart = Math.max(0, state.messages.length - reactiveTailMessages);
      if (
        tailStart > 0 &&
        isToolResultMessage(state.messages[tailStart]) &&
        hasToolUse(state.messages[tailStart - 1])
      ) {
        tailStart -= 1;
      }
      const earlier = state.messages.slice(0, tailStart);
      const tail = state.messages.slice(tailStart);
      if (earlier.length === 0) return;
      await writeTranscript(root, state.messages);
      const summary = await requireSummarizer(options.summarize)(earlier);
      state.messages = [
        { role: "user", content: `[Reactive compact]\n\n${summary}` },
        ...tail,
      ];
    },
  };
}

async function applyToolResultBudget(
  messages: MessageParam[],
  root: string,
  maxCharacters: number,
  previewLength: number,
  persistThreshold: number,
): Promise<void> {
  const lastMessage = messages.at(-1);
  const results = lastMessage ? collectToolResults([lastMessage]) : [];
  let total = results.reduce((sum, result) => sum + result.content.length, 0);
  if (total <= maxCharacters) return;

  const ranked = [...results].sort(
    (left, right) => right.content.length - left.content.length,
  );
  // 总量超限时，单条阈值不再拥有否决权：否则一堆"各自都不算大"的结果会让
  // 预算彻底失效。剩下的唯一硬约束是落盘必须真的换来体积收益。
  const minPersistLength = Math.max(
    previewLength,
    Math.min(persistThreshold, previewLength + PERSIST_REFERENCE_OVERHEAD),
  );
  for (const result of ranked) {
    if (total <= maxCharacters) break;
    if (result.content.length <= minPersistLength) continue;
    result.block.content = await persistToolResult(
      root,
      result.block.tool_use_id,
      result.content,
      previewLength,
    );
    total -= result.content.length;
    total += textContent(result.block.content).length;
  }
}

function snipMessages(
  messages: MessageParam[],
  maxMessages: number,
  keepHead: number,
): MessageParam[] {
  if (messages.length <= maxMessages) return messages;
  let headEnd = Math.min(keepHead, messages.length);
  let tailStart = messages.length - Math.max(0, maxMessages - keepHead);

  if (headEnd > 0 && hasToolUse(messages[headEnd - 1])) {
    while (
      headEnd < messages.length &&
      isToolResultMessage(messages[headEnd])
    ) {
      headEnd += 1;
    }
  }
  if (
    tailStart > 0 &&
    tailStart < messages.length &&
    isToolResultMessage(messages[tailStart]) &&
    hasToolUse(messages[tailStart - 1])
  ) {
    tailStart -= 1;
  }
  if (headEnd >= tailStart) return messages;

  const removed = tailStart - headEnd;
  return [
    ...messages.slice(0, headEnd),
    {
      role: "user",
      content: `[snipped ${removed} messages from conversation middle]`,
    },
    ...messages.slice(tailStart),
  ];
}

function microCompact(messages: MessageParam[], keepRecent: number): void {
  const results = collectToolResults(messages);
  const stale = results.slice(0, Math.max(0, results.length - keepRecent));
  if (stale.length === 0) return;

  const toolUses = collectToolUses(messages);
  for (const result of stale) {
    if (result.content.length <= MICRO_MIN_LENGTH) continue;
    // 已落盘的结果只丢预览、保住路径，否则恢复入口会被无声吞掉。
    const persisted = persistedOutputPath(result.content);
    const use = toolUses.get(result.block.tool_use_id);
    const placeholder = persisted
      ? persistedOutputReference(persisted)
      : microPlaceholder(use?.name, use?.input);
    if (placeholder.length < result.content.length) {
      result.block.content = placeholder;
    }
  }
}

function microPlaceholder(
  toolName: string | undefined,
  input: unknown,
): string {
  if (toolName === undefined) return "[Compacted: earlier tool result omitted.]";
  const serialized = JSON.stringify(input ?? {});
  const argument =
    serialized.length > MICRO_INPUT_PREVIEW
      ? `${serialized.slice(0, MICRO_INPUT_PREVIEW)}…`
      : serialized;
  return `[Compacted: ${toolName} ${argument} — already executed, output omitted here.]`;
}

async function compactHistory(
  messages: MessageParam[],
  root: string,
  summarize: (messages: MessageParam[]) => Promise<string>,
  label: string,
): Promise<MessageParam[]> {
  await writeTranscript(root, messages);
  const summary = await summarize(messages);
  return [{ role: "user", content: `[${label}]\n\n${summary}` }];
}

function collectToolResults(messages: MessageParam[]): Array<{
  block: ToolResultBlockParam;
  content: string;
}> {
  const results: Array<{ block: ToolResultBlockParam; content: string }> = [];
  for (const message of messages) {
    if (message.role !== "user" || typeof message.content === "string")
      continue;
    for (const block of message.content) {
      if (block.type !== "tool_result") continue;
      results.push({ block, content: textContent(block.content) });
    }
  }
  return results;
}

function collectToolUses(
  messages: MessageParam[],
): Map<string, { name: string; input: unknown }> {
  const uses = new Map<string, { name: string; input: unknown }>();
  for (const message of messages) {
    if (message.role !== "assistant" || typeof message.content === "string")
      continue;
    for (const block of message.content) {
      if (block.type !== "tool_use") continue;
      uses.set(block.id, { name: block.name, input: block.input });
    }
  }
  return uses;
}

function hasToolUse(message: MessageParam | undefined): boolean {
  return (
    message?.role === "assistant" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_use")
  );
}

function isToolResultMessage(message: MessageParam | undefined): boolean {
  return (
    message?.role === "user" &&
    Array.isArray(message.content) &&
    message.content.some((block) => block.type === "tool_result")
  );
}

function textContent(content: ToolResultBlockParam["content"]): string {
  if (content === undefined) return "";
  if (typeof content === "string") return content;
  return content
    .map((block) => (block.type === "text" ? block.text : "[image]"))
    .join("\n");
}

function contextTokens(state: State): number {
  if (state.lastInputTokens > 0) return state.lastInputTokens;
  return Math.ceil(estimateSize(state.messages) / CHARACTERS_PER_TOKEN);
}

function estimateSize(messages: MessageParam[]): number {
  return JSON.stringify(messages).length;
}

function requireSummarizer(
  summarize: ContextManagerOptions["summarize"],
): (messages: MessageParam[]) => Promise<string> {
  if (!summarize)
    throw new Error("ContextManager 需要 summarize 才能执行 LLM 压缩");
  return summarize;
}
