import { Box, Text, useStdout } from "ink";
import type { InlineSpan } from "@/markdown/inline.js";
import type { MarkdownBlock } from "@/markdown/blocks.js";
import { displayWidth, truncateToWidth } from "@/markdown/width.js";

export interface MarkdownProps {
  blocks: MarkdownBlock[];
}

export function Markdown({ blocks }: MarkdownProps): JSX.Element {
  const { stdout } = useStdout();
  const columns = stdout?.columns ?? 80;

  return (
    <Box flexDirection="column">
      {blocks.map((block, index) => (
        <MarkdownBlockView key={index} block={block} columns={columns} />
      ))}
    </Box>
  );
}

function MarkdownBlockView({
  block,
  columns,
}: {
  block: MarkdownBlock;
  columns: number;
}): JSX.Element {
  switch (block.kind) {
    case "heading":
      return (
        <Text bold color="cyan">
          <Spans spans={block.spans} />
        </Text>
      );
    case "paragraph":
      return (
        <Text>
          <Spans spans={block.spans} />
        </Text>
      );
    case "code":
      return (
        <Box flexDirection="column">
          {block.lang ? <Text dimColor>  {block.lang}</Text> : null}
          {block.lines.map((line, i) => (
            <Text key={i} color="cyan">
              {"  "}
              {line}
            </Text>
          ))}
        </Box>
      );
    case "list":
      return (
        <Box flexDirection="column">
          {block.items.map((item, i) => (
            <Text key={i}>
              {"  ".repeat(item.indent)}
              {block.ordered ? `${i + 1}. ` : "• "}
              <Spans spans={item.spans} />
            </Text>
          ))}
        </Box>
      );
    case "quote":
      return (
        <Text dimColor>
          {"│ "}
          <Spans spans={block.spans} />
        </Text>
      );
    case "rule":
      return <Text>{"─".repeat(columns)}</Text>;
    case "table":
      return <TableView block={block} columns={columns} />;
  }
}

function Spans({ spans }: { spans: InlineSpan[] }): JSX.Element {
  return (
    <>
      {spans.map((span, i) => {
        switch (span.kind) {
          case "text":
            return <Text key={i}>{span.text}</Text>;
          case "bold":
            return (
              <Text key={i} bold>
                {span.text}
              </Text>
            );
          case "italic":
            return (
              <Text key={i} italic>
                {span.text}
              </Text>
            );
          case "code":
            return (
              <Text key={i} color="yellow">
                {span.text}
              </Text>
            );
          case "link":
            return (
              <Text key={i} underline color="blue">
                {span.text}
              </Text>
            );
        }
      })}
    </>
  );
}

function TableView({
  block,
  columns,
}: {
  block: Extract<MarkdownBlock, { kind: "table" }>;
  columns: number;
}): JSX.Element {
  const columnCount = block.header.length;
  const cellText = (spans: InlineSpan[]): string => spans.map((span) => span.text).join("");

  const widths: number[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    const headerWidth = displayWidth(cellText(block.header[c] ?? []));
    const rowWidths = block.rows.map((row) => displayWidth(cellText(row[c] ?? [])));
    widths.push(Math.max(headerWidth, ...rowWidths, 3));
  }

  const maxTotalWidth = Math.max(columns - columnCount * 3 - 1, columnCount * 3);
  const scale = Math.min(1, maxTotalWidth / widths.reduce((a, b) => a + b, 0));
  const finalWidths = widths.map((width) => Math.max(3, Math.floor(width * scale)));

  function renderRow(cells: InlineSpan[][]): string {
    return (
      "│" +
      cells
        .map(
          (cell, i) =>
            ` ${padToDisplayWidth(cellText(cell), finalWidths[i]!)} `,
        )
        .join("│") +
      "│"
    );
  }

  function renderBorder(left: string, mid: string, right: string): string {
    return left + finalWidths.map((width) => "─".repeat(width + 2)).join(mid) + right;
  }

  return (
    <Box flexDirection="column">
      <Text>{renderBorder("┌", "┬", "┐")}</Text>
      <Text>{renderRow(block.header)}</Text>
      <Text>{renderBorder("├", "┼", "┤")}</Text>
      {block.rows.map((row, i) => (
        <Text key={i}>{renderRow(row)}</Text>
      ))}
      <Text>{renderBorder("└", "┴", "┘")}</Text>
    </Box>
  );
}

function padToDisplayWidth(text: string, width: number): string {
  const truncated = truncateToWidth(text, width);
  return truncated + " ".repeat(Math.max(0, width - displayWidth(truncated)));
}
