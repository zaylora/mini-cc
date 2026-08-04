import { expect, test } from "bun:test";
import { parseBlocks } from "@/markdown/blocks.js";

test("标题：读到换行即封闭", () => {
  const { blocks, closed } = parseBlocks("# Title\n");
  expect(blocks).toEqual([
    { kind: "heading", level: 1, spans: [{ kind: "text", text: "Title" }] },
  ]);
  expect(closed).toEqual([true]);
});

test("标题：没有换行时视为未封闭", () => {
  const { closed } = parseBlocks("# Title");
  expect(closed).toEqual([false]);
});

test("h1/h2/h3 级别识别正确", () => {
  const { blocks } = parseBlocks("# a\n## b\n### c\n");
  expect(blocks.map((b) => (b.kind === "heading" ? b.level : null))).toEqual([1, 2, 3]);
});

test("段落：空行之后封闭", () => {
  const { blocks, closed } = parseBlocks("hello\nworld\n\n");
  expect(blocks).toEqual([
    { kind: "paragraph", spans: [{ kind: "text", text: "hello\nworld" }] },
  ]);
  expect(closed).toEqual([true]);
});

test("段落：作为最后一块时永远未封闭", () => {
  const { closed } = parseBlocks("hello world");
  expect(closed).toEqual([false]);
});

test("围栏代码块：读到收尾三反引号才封闭", () => {
  const { blocks, closed } = parseBlocks("```ts\nconst a = 1;\n```\n");
  expect(blocks).toEqual([
    { kind: "code", lang: "ts", lines: ["const a = 1;"] },
  ]);
  expect(closed).toEqual([true]);
});

test("围栏代码块：未读到收尾时未封闭，即便流内有换行", () => {
  const { closed } = parseBlocks("```ts\nconst a = 1;\n");
  expect(closed).toEqual([false]);
});

test("无序列表：- 前缀", () => {
  const { blocks } = parseBlocks("- a\n- b\n\n");
  expect(blocks).toEqual([
    {
      kind: "list",
      ordered: false,
      items: [
        { spans: [{ kind: "text", text: "a" }], indent: 0 },
        { spans: [{ kind: "text", text: "b" }], indent: 0 },
      ],
    },
  ]);
});

test("有序列表：数字加点前缀", () => {
  const { blocks } = parseBlocks("1. a\n2. b\n\n");
  expect(blocks).toEqual([
    {
      kind: "list",
      ordered: true,
      items: [
        { spans: [{ kind: "text", text: "a" }], indent: 0 },
        { spans: [{ kind: "text", text: "b" }], indent: 0 },
      ],
    },
  ]);
});

test("引用：> 前缀", () => {
  const { blocks } = parseBlocks("> quoted text\n\n");
  expect(blocks).toEqual([
    { kind: "quote", spans: [{ kind: "text", text: "quoted text" }] },
  ]);
});

test("分割线：三个及以上连字符独占一行", () => {
  const { blocks, closed } = parseBlocks("---\n");
  expect(blocks).toEqual([{ kind: "rule" }]);
  expect(closed).toEqual([true]);
});

test("表格：header + 分隔行 + 数据行", () => {
  const { blocks } = parseBlocks("| a | b |\n|---|---|\n| 1 | 2 |\n\n");
  expect(blocks).toEqual([
    {
      kind: "table",
      header: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]],
      align: ["left", "left"],
      rows: [[[{ kind: "text", text: "1" }], [{ kind: "text", text: "2" }]]],
    },
  ]);
});

test("表格：单独一行且是最后一块时保持未封闭（lookahead 陷阱）", () => {
  const { closed } = parseBlocks("| a | b |");
  expect(closed).toEqual([false]);
});

test("表格：后续数据行尚未闭合时表格保持未封闭", () => {
  const { blocks, closed } = parseBlocks("| a | b |\n|---|---|\n|");
  expect(blocks[0]?.kind).toBe("table");
  expect(closed[0]).toBe(false);
});

test("closeAll: true 强制封闭所有块", () => {
  const { closed } = parseBlocks("# Title", { closeAll: true });
  expect(closed).toEqual([true]);
});

test("endOffsets 对应每块在源码中的结束位置", () => {
  const source = "# a\n\nhello\n\n";
  const { blocks, endOffsets } = parseBlocks(source, { closeAll: true });
  expect(blocks).toHaveLength(2);
  expect(source.slice(0, endOffsets[0])).toBe("# a\n");
});

test("多个块混排时只有最后一块未封闭", () => {
  const { closed } = parseBlocks("# a\n\nhello world");
  expect(closed).toEqual([true, false]);
});
