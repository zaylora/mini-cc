import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { displayWidth } from "@/markdown/width.js";
import { Markdown } from "@/tui/components/Markdown.js";
import type { MarkdownBlock } from "@/markdown/blocks.js";

test("渲染标题", () => {
  const blocks: MarkdownBlock[] = [
    { kind: "heading", level: 1, spans: [{ kind: "text", text: "Title" }] },
  ];
  const frame = render(<Markdown blocks={blocks} />).lastFrame();
  expect(frame).toContain("Title");
});

test("渲染粗体、斜体、行内代码 span", () => {
  const blocks: MarkdownBlock[] = [
    {
      kind: "paragraph",
      spans: [
        { kind: "text", text: "a " },
        { kind: "bold", text: "bold" },
        { kind: "text", text: " b " },
        { kind: "italic", text: "it" },
        { kind: "text", text: " c " },
        { kind: "code", text: "code" },
      ],
    },
  ];
  const frame = render(<Markdown blocks={blocks} />).lastFrame();
  expect(frame).toContain("bold");
  expect(frame).toContain("it");
  expect(frame).toContain("code");
});

test("渲染围栏代码块，缩进两空格", () => {
  const blocks: MarkdownBlock[] = [
    { kind: "code", lang: "ts", lines: ["const a = 1;"] },
  ];
  const frame = render(<Markdown blocks={blocks} />).lastFrame();
  expect(frame).toContain("const a = 1;");
  expect(frame).toContain("ts");
});

test("渲染无序列表带 bullet 前缀", () => {
  const blocks: MarkdownBlock[] = [
    {
      kind: "list",
      ordered: false,
      items: [{ spans: [{ kind: "text", text: "item one" }], indent: 0 }],
    },
  ];
  const frame = render(<Markdown blocks={blocks} />).lastFrame();
  expect(frame).toContain("•");
  expect(frame).toContain("item one");
});

test("渲染有序列表带数字前缀", () => {
  const blocks: MarkdownBlock[] = [
    {
      kind: "list",
      ordered: true,
      items: [{ spans: [{ kind: "text", text: "first" }], indent: 0 }],
    },
  ];
  const frame = render(<Markdown blocks={blocks} />).lastFrame();
  expect(frame).toContain("1.");
  expect(frame).toContain("first");
});

test("渲染引用带竖线前缀", () => {
  const blocks: MarkdownBlock[] = [
    { kind: "quote", spans: [{ kind: "text", text: "quoted" }] },
  ];
  const frame = render(<Markdown blocks={blocks} />).lastFrame();
  expect(frame).toContain("│");
  expect(frame).toContain("quoted");
});

test("渲染分割线", () => {
  const blocks: MarkdownBlock[] = [{ kind: "rule" }];
  const frame = render(<Markdown blocks={blocks} />).lastFrame();
  expect(frame).toContain("─");
});

test("渲染表格带边框与单元格内容", () => {
  const blocks: MarkdownBlock[] = [
    {
      kind: "table",
      header: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]],
      align: ["left", "left"],
      rows: [[[{ kind: "text", text: "1" }], [{ kind: "text", text: "2" }]]],
    },
  ];
  const frame = render(<Markdown blocks={blocks} />).lastFrame();
  expect(frame).toContain("a");
  expect(frame).toContain("b");
  expect(frame).toContain("1");
  expect(frame).toContain("2");
  expect(frame).toContain("┌");
});

test("CJK 表格内容与边框保持相同显示宽度", () => {
  const blocks: MarkdownBlock[] = [
    {
      kind: "table",
      header: [[{ kind: "text", text: "列" }]],
      align: ["left"],
      rows: [[[{ kind: "text", text: "你好" }]]],
    },
  ];
  const frame = render(<Markdown blocks={blocks} />).lastFrame() ?? "";
  const widths = frame.split("\n").map(displayWidth);
  expect(new Set(widths).size).toBe(1);
});

test("长表格压缩后不超过终端宽度或产生额外换行", () => {
  const blocks: MarkdownBlock[] = [
    {
      kind: "table",
      header: [
        [{ kind: "text", text: "目录" }],
        [{ kind: "text", text: "职责" }],
      ],
      align: ["left", "left"],
      rows: [
        [
          [{ kind: "text", text: "core/" }],
          [
            {
              kind: "text",
              text: "Agent 主循环（loop.ts）、状态（state.ts）、LLM 调用与重试恢复（llm.ts）、事件总线（events.ts）、上下文压缩/裁剪策略（manager.ts）、大结果落盘（persist.ts）",
            },
          ],
        ],
        [
          [{ kind: "text", text: "tools/" }],
          [
            {
              kind: "text",
              text: "工具实现：bash、fs（read/write/edit/glob）、todo、task（子 Agent）、skill，统一注册",
            },
          ],
        ],
      ],
    },
  ];

  const frame = render(<Markdown blocks={blocks} />).lastFrame() ?? "";
  const lines = frame.split("\n");

  expect(lines).toHaveLength(6);
  expect(lines.every((line) => displayWidth(line) <= 100)).toBe(true);
});
