import { Box, Text } from "ink";
import type { DisplayEntry } from "@/tui/displayLog.js";

export interface MessageListProps {
  entries: DisplayEntry[];
}

export function MessageList({ entries }: MessageListProps): JSX.Element {
  return (
    <Box flexDirection="column">
      {entries.map((entry, index) => (
        <Text key={index}>{formatEntry(entry)}</Text>
      ))}
    </Box>
  );
}

function formatEntry(entry: DisplayEntry): string {
  if (entry.kind === "user") return `> ${entry.text}`;
  if (entry.kind === "system") return `* ${entry.text}`;

  const indent = "  ".repeat(entry.depth) + (entry.depth > 0 ? "↳ " : "");
  if (entry.kind === "assistant") return `${indent}${entry.text}`;

  const status = entry.result === undefined ? "运行中…" : entry.isError ? "失败" : "完成";
  const resultLine = entry.result === undefined ? "" : `\n${indent}  ${entry.result}`;
  return `${indent}[工具 ${entry.toolName} ${status}]${resultLine}`;
}
