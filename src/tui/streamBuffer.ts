import { parseBlocks, type MarkdownBlock } from "@/markdown/blocks.js";

export interface StreamBuffer {
  pending: string;
}

export function createStreamBuffer(): StreamBuffer {
  return { pending: "" };
}

export function pushDelta(
  buffer: StreamBuffer,
  delta: string,
): { buffer: StreamBuffer; committed: MarkdownBlock[]; tail: MarkdownBlock[] } {
  const pending = buffer.pending + delta;
  return splitCommittedAndTail(pending);
}

export function flush(buffer: StreamBuffer): { buffer: StreamBuffer; committed: MarkdownBlock[] } {
  const { blocks } = parseBlocks(buffer.pending, { closeAll: true });
  return { buffer: { pending: "" }, committed: blocks };
}

function splitCommittedAndTail(
  pending: string,
): { buffer: StreamBuffer; committed: MarkdownBlock[]; tail: MarkdownBlock[] } {
  const { blocks, closed, endOffsets } = parseBlocks(pending);

  let lastClosedIndex = -1;
  for (let i = 0; i < closed.length; i += 1) {
    if (closed[i]) lastClosedIndex = i;
    else break;
  }

  const committed = blocks.slice(0, lastClosedIndex + 1);
  const tail = blocks.slice(lastClosedIndex + 1);
  const consumedLength = lastClosedIndex >= 0 ? endOffsets[lastClosedIndex]! : 0;
  const remainingPending = pending.slice(consumedLength);

  return {
    buffer: { pending: remainingPending },
    committed,
    tail,
  };
}
