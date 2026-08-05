import { Box, Static, Text } from "ink";
import type { MarkdownBlock } from "@/markdown/blocks.js";
import type { DisplayEntry } from "@/tui/model/displayLog.js";
import { Markdown } from "@/tui/components/Markdown.js";
import {
  describeToolCall,
  toolDotColor,
  toolLabel,
} from "@/tui/model/toolCallFormat.js";

export interface MessageListProps {
  staticEntries: DisplayEntry[];
  pendingEntries: DisplayEntry[];
  streamingBlocks: MarkdownBlock[];
}

export function MessageList({
  staticEntries,
  pendingEntries,
  streamingBlocks,
}: MessageListProps): JSX.Element {
  const activeTools = pendingEntries.filter(
    (entry): entry is ToolEntry => entry.kind === "tool" && entry.result === undefined,
  );
  return (
    <Box flexDirection="column">
      <Static items={staticEntries}>{(entry) => renderEntry(entry)}</Static>
      {activeTools.map((entry) => renderEntry(entry))}
      {streamingBlocks.length > 0 ? <Markdown blocks={streamingBlocks} /> : null}
    </Box>
  );
}

type ToolEntry = Extract<DisplayEntry, { kind: "tool" }>;
type AssistantBlockEntry = Extract<DisplayEntry, { kind: "assistant-block" }>;

function renderEntry(entry: DisplayEntry): JSX.Element {
  if (entry.kind === "tool") return <ToolLine key={entry.id} entry={entry} />;
  if (entry.kind === "assistant-block") {
    return <AssistantBlockLine key={entry.id} entry={entry} />;
  }
  return <Text key={entry.id}>{formatEntry(entry)}</Text>;
}

function AssistantBlockLine({ entry }: { entry: AssistantBlockEntry }): JSX.Element {
  const indent = "  ".repeat(entry.depth) + (entry.depth > 0 ? "↳ " : "");
  if (indent === "") {
    return <Markdown blocks={[entry.block]} />;
  }
  return (
    <Box flexDirection="row">
      <Text>{indent}</Text>
      <Markdown blocks={[entry.block]} />
    </Box>
  );
}

function ToolLine({ entry }: { entry: ToolEntry }): JSX.Element {
  const indent = "  ".repeat(entry.depth) + (entry.depth > 0 ? "↳ " : "");
  return (
    <Text>
      {indent}
      <Text color={toolDotColor(entry)}>●</Text>{" "}
      {toolLabel(entry.toolName)}({describeToolCall(entry.toolName, entry.input)})
    </Text>
  );
}

function formatEntry(
  entry: Exclude<DisplayEntry, { kind: "tool" | "assistant-block" }>,
): string {
  if (entry.kind === "user") return `> ${entry.text}`;
  if (entry.kind === "system") return `* ${entry.text}`;
  const indent = "  ".repeat(entry.depth) + (entry.depth > 0 ? "↳ " : "");
  return `${indent}${entry.text}`;
}
