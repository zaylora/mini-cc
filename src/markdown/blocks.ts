import { parseInline, type InlineSpan } from "@/markdown/inline.js";

export type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "code"; lang?: string; lines: string[] }
  | { kind: "list"; ordered: boolean; items: { spans: InlineSpan[]; indent: number }[] }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "rule" }
  | {
      kind: "table";
      header: InlineSpan[][];
      align: ("left" | "center" | "right")[];
      rows: InlineSpan[][][];
    };

export interface ParseBlocksResult {
  blocks: MarkdownBlock[];
  closed: boolean[];
  endOffsets: number[];
}

const HEADING_PATTERN = /^(#{1,3})\s+(.*)$/;
const ORDERED_ITEM_PATTERN = /^\d+\.\s+(.*)$/;
const UNORDERED_ITEM_PATTERN = /^[-*]\s+(.*)$/;
const QUOTE_PATTERN = /^>\s?(.*)$/;
const RULE_PATTERN = /^-{3,}$/;
const TABLE_ROW_PATTERN = /^\|(.*)\|$/;
const TABLE_SEPARATOR_PATTERN = /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/;
const CODE_FENCE_PATTERN = /^```(\S*)$/;

interface Line {
  text: string;
  start: number;
  end: number;
}

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let cursor = 0;
  while (cursor <= source.length) {
    const newlineIndex = source.indexOf("\n", cursor);
    if (newlineIndex === -1) {
      if (cursor < source.length) {
        lines.push({ text: source.slice(cursor), start: cursor, end: source.length });
      }
      break;
    }
    lines.push({ text: source.slice(cursor, newlineIndex), start: cursor, end: newlineIndex + 1 });
    cursor = newlineIndex + 1;
  }
  return lines;
}

export function parseBlocks(
  source: string,
  opts: { closeAll?: boolean } = {},
): ParseBlocksResult {
  const lines = splitLines(source);
  const blocks: MarkdownBlock[] = [];
  const closed: boolean[] = [];
  const endOffsets: number[] = [];
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    const hasTrailingNewline = source[line.end - 1] === "\n";

    if (RULE_PATTERN.test(line.text)) {
      blocks.push({ kind: "rule" });
      closed.push(hasTrailingNewline);
      endOffsets.push(line.end);
      index += 1;
      continue;
    }

    const headingMatch = HEADING_PATTERN.exec(line.text);
    if (headingMatch) {
      blocks.push({
        kind: "heading",
        level: headingMatch[1]!.length as 1 | 2 | 3,
        spans: parseInline(headingMatch[2]!),
      });
      closed.push(hasTrailingNewline);
      endOffsets.push(line.end);
      index += 1;
      continue;
    }

    const fenceMatch = CODE_FENCE_PATTERN.exec(line.text);
    if (fenceMatch) {
      const lang = fenceMatch[1] || undefined;
      const codeLines: string[] = [];
      let cursor = index + 1;
      let closingIndex = -1;
      while (cursor < lines.length) {
        if (lines[cursor]!.text === "```") {
          closingIndex = cursor;
          break;
        }
        codeLines.push(lines[cursor]!.text);
        cursor += 1;
      }
      blocks.push({ kind: "code", lang, lines: codeLines });
      if (closingIndex === -1) {
        closed.push(false);
        endOffsets.push(lines.at(-1)?.end ?? source.length);
        index = lines.length;
      } else {
        closed.push(true);
        endOffsets.push(lines[closingIndex]!.end);
        index = closingIndex + 1;
      }
      continue;
    }

    const tableRowMatch = TABLE_ROW_PATTERN.exec(line.text);
    if (tableRowMatch) {
      const nextLine = lines[index + 1];
      if (nextLine !== undefined && TABLE_SEPARATOR_PATTERN.test(nextLine.text)) {
        const header = splitTableRow(line.text);
        const align = parseAlignRow(nextLine.text);
        const rows: InlineSpan[][][] = [];
        let cursor = index + 2;
        while (cursor < lines.length && TABLE_ROW_PATTERN.test(lines[cursor]!.text)) {
          rows.push(splitTableRow(lines[cursor]!.text));
          cursor += 1;
        }
        const hasPendingTableRow =
          cursor < lines.length && lines[cursor]!.text.startsWith("|");
        const isLastBlockLine = cursor >= lines.length || hasPendingTableRow;
        blocks.push({ kind: "table", header, align, rows });
        closed.push(!isLastBlockLine || opts.closeAll === true);
        endOffsets.push(lines[cursor - 1]!.end);
        index = cursor;
        continue;
      }
    }

    if (line.text.trim() === "") {
      index += 1;
      continue;
    }

    const orderedMatch = ORDERED_ITEM_PATTERN.exec(line.text);
    const unorderedMatch = UNORDERED_ITEM_PATTERN.exec(line.text);
    if (orderedMatch || unorderedMatch) {
      const ordered = orderedMatch !== null;
      const items: { spans: InlineSpan[]; indent: number }[] = [];
      let cursor = index;
      while (cursor < lines.length) {
        const itemLine = lines[cursor]!;
        const itemMatch = ordered
          ? ORDERED_ITEM_PATTERN.exec(itemLine.text)
          : UNORDERED_ITEM_PATTERN.exec(itemLine.text);
        if (!itemMatch) break;
        items.push({ spans: parseInline(itemMatch[1]!), indent: 0 });
        cursor += 1;
      }
      const isLastBlockLine = cursor >= lines.length;
      blocks.push({ kind: "list", ordered, items });
      pushParagraphLikeClosed(closed, endOffsets, lines, cursor, isLastBlockLine, opts.closeAll);
      index = cursor;
      continue;
    }

    const quoteMatch = QUOTE_PATTERN.exec(line.text);
    if (quoteMatch) {
      const quoteLines: string[] = [quoteMatch[1]!];
      let cursor = index + 1;
      while (cursor < lines.length) {
        const nextMatch = QUOTE_PATTERN.exec(lines[cursor]!.text);
        if (!nextMatch) break;
        quoteLines.push(nextMatch[1]!);
        cursor += 1;
      }
      const isLastBlockLine = cursor >= lines.length;
      blocks.push({ kind: "quote", spans: parseInline(quoteLines.join("\n")) });
      pushParagraphLikeClosed(closed, endOffsets, lines, cursor, isLastBlockLine, opts.closeAll);
      index = cursor;
      continue;
    }

    const paragraphLines: string[] = [line.text];
    let cursor = index + 1;
    while (
      cursor < lines.length &&
      lines[cursor]!.text.trim() !== "" &&
      !isBlockStart(lines[cursor]!.text, lines[cursor + 1])
    ) {
      paragraphLines.push(lines[cursor]!.text);
      cursor += 1;
    }
    const isLastBlockLine = cursor >= lines.length;
    blocks.push({ kind: "paragraph", spans: parseInline(paragraphLines.join("\n")) });
    pushParagraphLikeClosed(closed, endOffsets, lines, cursor, isLastBlockLine, opts.closeAll);
    index = cursor;
  }

  if (opts.closeAll) {
    closed.fill(true);
  }

  return { blocks, closed, endOffsets };
}

function pushParagraphLikeClosed(
  closed: boolean[],
  endOffsets: number[],
  lines: Line[],
  cursor: number,
  isLastBlockLine: boolean,
  closeAll: boolean | undefined,
): void {
  const lastConsumedLine = lines[cursor - 1]!;
  endOffsets.push(lastConsumedLine.end);
  closed.push(closeAll === true || !isLastBlockLine);
}

function isBlockStart(text: string, nextLine: Line | undefined): boolean {
  if (HEADING_PATTERN.test(text)) return true;
  if (RULE_PATTERN.test(text)) return true;
  if (CODE_FENCE_PATTERN.test(text)) return true;
  if (ORDERED_ITEM_PATTERN.test(text) || UNORDERED_ITEM_PATTERN.test(text)) return true;
  if (QUOTE_PATTERN.test(text)) return true;
  if (TABLE_ROW_PATTERN.test(text) && nextLine !== undefined && TABLE_SEPARATOR_PATTERN.test(nextLine.text)) {
    return true;
  }
  return false;
}

function splitTableRow(text: string): InlineSpan[][] {
  const inner = text.slice(1, -1);
  return inner.split("|").map((cell) => parseInline(cell.trim()));
}

function parseAlignRow(text: string): ("left" | "center" | "right")[] {
  const inner = text.replace(/^\|/, "").replace(/\|$/, "");
  return inner.split("|").map((cell) => {
    const trimmed = cell.trim();
    const left = trimmed.startsWith(":");
    const right = trimmed.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    return "left";
  });
}
