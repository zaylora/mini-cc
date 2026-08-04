import { expect, test } from "bun:test";
import { createStreamBuffer, pushDelta, flush } from "@/tui/model/streamBuffer.js";

test("单个完整段落一次性 delta 后立即视为尾块（未封闭，因为它是最后一块）", () => {
  const buffer = createStreamBuffer();
  const { committed, tail } = pushDelta(buffer, "hello world");
  expect(committed).toEqual([]);
  expect(tail).toHaveLength(1);
  expect(tail[0]).toMatchObject({ kind: "paragraph" });
});

test("标题后跟换行立即提交为 committed", () => {
  const buffer = createStreamBuffer();
  const { committed, tail } = pushDelta(buffer, "# Title\n");
  expect(committed).toHaveLength(1);
  expect(committed[0]).toMatchObject({ kind: "heading", level: 1 });
  expect(tail).toEqual([]);
});

test("段落后跟空行触发提交，随后的新段落是尾块", () => {
  const buffer = createStreamBuffer();
  const result = pushDelta(buffer, "first paragraph\n\nsecond");
  expect(result.committed).toHaveLength(1);
  expect(result.committed[0]).toMatchObject({ kind: "paragraph" });
  expect(result.tail).toHaveLength(1);
  expect(result.tail[0]).toMatchObject({ kind: "paragraph" });
});

test("逐字符喂入代码块：任意中间状态都不提交未封闭的代码块", () => {
  const source = "```ts\nconst a = 1;\nconsole.log(a);\n```\n";
  let buffer = createStreamBuffer();
  const allCommitted: unknown[] = [];
  for (const char of source) {
    const result = pushDelta(buffer, char);
    buffer = result.buffer;
    allCommitted.push(...result.committed);
    for (const block of result.committed) {
      if (block.kind === "code") {
        expect(block.lines.join("\n")).not.toContain("```");
      }
    }
  }
  const finalResult = flush(buffer);
  allCommitted.push(...finalResult.committed);
  const codeBlocks = allCommitted.filter((b: any) => b.kind === "code");
  expect(codeBlocks).toHaveLength(1);
  expect((codeBlocks[0] as any).lines).toEqual(["const a = 1;", "console.log(a);"]);
});

test("逐字符喂入表格：中间状态不会把表格提交成段落", () => {
  const source = "| a | b |\n|---|---|\n| 1 | 2 |\n\n";
  let buffer = createStreamBuffer();
  const allCommitted: unknown[] = [];
  for (const char of source) {
    const result = pushDelta(buffer, char);
    buffer = result.buffer;
    allCommitted.push(...result.committed);
  }
  const finalResult = flush(buffer);
  allCommitted.push(...finalResult.committed);
  const paragraphs = allCommitted.filter((b: any) => b.kind === "paragraph");
  const tables = allCommitted.filter((b: any) => b.kind === "table");
  expect(tables).toHaveLength(1);
  expect(paragraphs).toHaveLength(0);
});

test("flush 强制封闭尾块", () => {
  const buffer = createStreamBuffer();
  const { buffer: b1 } = pushDelta(buffer, "# Title");
  const { committed } = flush(b1);
  expect(committed).toHaveLength(1);
  expect(committed[0]).toMatchObject({ kind: "heading" });
});

test("已提交的块不会在后续 delta 中重复出现", () => {
  let buffer = createStreamBuffer();
  const first = pushDelta(buffer, "# Title\n");
  buffer = first.buffer;
  const second = pushDelta(buffer, "more text");
  expect(second.committed).toEqual([]);
  expect(second.tail).toHaveLength(1);
  expect(second.tail[0]).toMatchObject({
    kind: "paragraph",
    spans: [{ kind: "text", text: "more text" }],
  });
});
