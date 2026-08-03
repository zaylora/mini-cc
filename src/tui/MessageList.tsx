import { Box, Static, Text } from "ink";
import type { DisplayEntry } from "@/tui/displayLog.js";
import {
  describeToolCall,
  toolDotColor,
  toolLabel,
} from "@/tui/toolCallFormat.js";

export interface MessageListProps {
  staticEntries: DisplayEntry[];
  pendingEntries: DisplayEntry[];
}

export function MessageList({ staticEntries, pendingEntries }: MessageListProps): JSX.Element {
  return (
    <Box flexDirection="column">
      <Static items={staticEntries}>
        {(entry) => renderEntry(entry)}
      </Static>
      {pendingEntries.map((entry) => (
        renderEntry(entry)
      ))}
    </Box>
  );
}

type ToolEntry = Extract<DisplayEntry, { kind: "tool" }>;

function renderEntry(entry: DisplayEntry): JSX.Element {
  return entry.kind === "tool" ? (
    <ToolLine key={entry.id} entry={entry} />
  ) : (
    <Text key={entry.id}>{formatEntry(entry)}</Text>
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
  entry: Exclude<DisplayEntry, { kind: "tool" }>,
): string {
  if (entry.kind === "user") return `> ${entry.text}`;
  if (entry.kind === "system") return `* ${entry.text}`;

  const indent = "  ".repeat(entry.depth) + (entry.depth > 0 ? "↳ " : "");
  return `${indent}${entry.text}`;
}
