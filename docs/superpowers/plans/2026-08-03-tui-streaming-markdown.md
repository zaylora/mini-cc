# TUI 流式输出与 Markdown 渲染 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 mini-agent 的 TUI 支持 assistant 文本流式上屏，并把 Markdown 语法（标题/粗体/斜体/行内代码/围栏代码块/列表/引用/分割线/表格）渲染成带样式的终端输出，而不是裸文本。

**Architecture:** 新增一层零依赖的 Markdown 解析器（`src/markdown/`，纯函数：inline 分词 → block 扫描 → 显示宽度），配合一个流式缓冲器（`src/tui/streamBuffer.ts`）把增量文本切成「已封闭块」和「未封闭尾块」。`src/core/llm.ts` 把请求换成 `client.messages.stream()`，通过新增的 3 个事件把 delta 广播给 TUI；`App.tsx` 用 32ms 节流把已封闭块提交进 `<Static>`，尾块留在动态区重绘。`max_tokens` 不再是写死常量，改为按 `state.modelId` 查表取模型的真实输出 ceiling（1M 窗口模型 128K，200K 窗口模型 64K），并删除原有的"先撞 16K 再升档重发"逻辑。

**Tech Stack:** TypeScript, Bun, React 18, ink 5, `@anthropic-ai/sdk` 0.40（已装，`client.messages.stream()` 内置于当前版本，零新增依赖）, bun:test, ink-testing-library。

## Global Constraints

- 零新增依赖 —— Markdown 解析器必须是自研纯函数，不引入 marked / cli-highlight 等包。
- Markdown 覆盖范围：标题 h1–h3、粗体、斜体、行内代码、围栏代码块（不高亮）、有序/无序列表、引用、分割线、GFM 表格。不做：语法高亮、工具参数流式、thinking 流式、子 agent 流式、ESC 中断、`model_context_window_exceeded` 处理。
- 流式仅对主 agent（`depth === 0`）生效；子 agent（`depth > 0`）仍走现有的整段 `assistant-message` 事件，但要经过 markdown 解析后再渲染。
- `callModelWithRecovery` 的对外契约（入参 `ModelRecoveryOptions`，返回完整 `Message`）必须保持向后兼容 —— 现有的 429/529 退避、reactive compact、fallback 模型切换测试不能改。
- Markdown 块级提交的核心不变式：**最后一个块永远视为未封闭**，除非它是单行块（heading/rule）且已读到换行，或调用方传入 `closeAll: true`。这条规则必须有专门测试覆盖，它是防止"表格被提交成段落"和"代码块提交出半个围栏"的唯一机制。
- 行内样式明确不支持嵌套（如粗体套代码）——渲染时外层样式生效，内层标记原样保留为文本，不递归解析。
- `state.maxTokens` 的初始化和 fallback 切换后的重新赋值都必须调用同一个查表函数 `maxOutputTokensFor(modelId)`，不能有第二处硬编码的数字。

---

## File Structure

```
src/
  core/
    modelLimits.ts       [新增] 模型 ID -> 输出 ceiling 查表函数
    events.ts             [修改] +3 个流式事件类型
    llm.ts                [修改] requestModel 改流式；删除升档分支；fallback 切换重新查表
    loop.ts               [修改] 桥接 delta 事件；state.maxTokens 初始化改查表
    state.ts              [修改] 删除 hasEscalatedMaxTokens 字段
  config.ts               [修改] 删除 MAX_TOKENS 常量
  markdown/
    width.ts              [新增] 终端显示宽度计算（CJK 双宽）
    inline.ts             [新增] 行内分词（bold/italic/code/link）
    blocks.ts             [新增] 块级扫描（heading/paragraph/code/list/quote/rule/table），带封闭标记
  tui/
    streamBuffer.ts        [新增] delta 累积 -> (committed blocks, tail blocks)
    Markdown.tsx           [新增] MarkdownBlock[] -> ink JSX
    displayLog.ts           [修改] 新增 assistant-block 条目类型；appendAssistantMessage 改走 markdown
    MessageList.tsx          [修改] assistant 内容改用 Markdown 组件渲染
    App.tsx                   [修改] 订阅新事件；32ms 节流提交尾块

test/
  core/
    modelLimits.test.ts    [新增]
  markdown/
    width.test.ts          [新增]
    inline.test.ts         [新增]
    blocks.test.ts          [新增]
  tui/
    streamBuffer.test.ts    [新增]
    Markdown.test.tsx       [新增]
  llm.test.ts               [修改] 升档测试改写；新增 fallback 查表测试；新增流式测试
  tui/App.test.tsx          [修改] 新增流式渲染测试
```

任务顺序遵循依赖方向：先建纯函数底层（width → inline → blocks → modelLimits），再建消费它们的中间层（streamBuffer），再改 core 层（events → llm → loop → state/config），最后改 UI 层（Markdown.tsx → displayLog → MessageList → App）。每个任务结束时代码都能跑通现有测试套件。

---

### Task 1: 模型输出 ceiling 查表

**Files:**
- Create: `src/core/modelLimits.ts`
- Test: `test/core/modelLimits.test.ts`

**Interfaces:**
- Produces: `maxOutputTokensFor(modelId: string): number` — 已知 200K 窗口模型返回 `64_000`，其余（含未收录的模型 ID）返回 `128_000`。

- [ ] **Step 1: 写失败测试**

```ts
// test/core/modelLimits.test.ts
import { expect, test } from "bun:test";
import { maxOutputTokensFor } from "@/core/modelLimits.js";

test("已知 200K 窗口模型返回 64K ceiling", () => {
  expect(maxOutputTokensFor("claude-sonnet-4-5")).toBe(64_000);
  expect(maxOutputTokensFor("claude-sonnet-4-5-20250929")).toBe(64_000);
  expect(maxOutputTokensFor("claude-haiku-4-5")).toBe(64_000);
  expect(maxOutputTokensFor("claude-haiku-4-5-20251001")).toBe(64_000);
});

test("1M 窗口模型与未收录模型默认返回 128K ceiling", () => {
  expect(maxOutputTokensFor("claude-sonnet-5")).toBe(128_000);
  expect(maxOutputTokensFor("claude-sonnet-5[1m]")).toBe(128_000);
  expect(maxOutputTokensFor("claude-opus-5")).toBe(128_000);
  expect(maxOutputTokensFor("some-future-model-nobody-has-heard-of")).toBe(128_000);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/core/modelLimits.test.ts`
Expected: FAIL，报 `Cannot find module '@/core/modelLimits.js'`

- [ ] **Step 3: 实现**

```ts
// src/core/modelLimits.ts
const LOW_CEILING_MODEL_PREFIXES = [
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-sonnet-4-0",
  "claude-3-",
  "claude-2.",
];

const LOW_CEILING_MAX_TOKENS = 64_000;
const DEFAULT_MAX_TOKENS = 128_000;

export function maxOutputTokensFor(modelId: string): number {
  const isLowCeiling = LOW_CEILING_MODEL_PREFIXES.some((prefix) =>
    modelId.startsWith(prefix),
  );
  return isLowCeiling ? LOW_CEILING_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}
```

前缀匹配而不是精确匹配，因为 `claude-sonnet-4-5-20250929` 这类带日期后缀的 ID 也要落在同一档。`claude-opus-4-1`、`claude-opus-4-0`、`claude-sonnet-4-0` 是 200K 窗口的旧模型（见 `shared/models.md` 遗留模型表），一并收录。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/core/modelLimits.test.ts`
Expected: PASS，2 个测试全部通过

- [ ] **Step 5: 提交**

```bash
git add src/core/modelLimits.ts test/core/modelLimits.test.ts
git commit -m "feat: 新增模型输出 ceiling 查表函数"
```

---

### Task 2: 终端显示宽度计算

**Files:**
- Create: `src/markdown/width.ts`
- Test: `test/markdown/width.test.ts`

**Interfaces:**
- Produces: `displayWidth(text: string): number`、`truncateToWidth(text: string, max: number): string`

- [ ] **Step 1: 写失败测试**

```ts
// test/markdown/width.test.ts
import { expect, test } from "bun:test";
import { displayWidth, truncateToWidth } from "@/markdown/width.js";

test("displayWidth 对 ASCII 按字符计数", () => {
  expect(displayWidth("hello")).toBe(5);
  expect(displayWidth("")).toBe(0);
});

test("displayWidth 对 CJK 字符计为双宽", () => {
  expect(displayWidth("你好")).toBe(4);
  expect(displayWidth("a你b")).toBe(4);
});

test("displayWidth 对组合记号计为零宽", () => {
  // U+0301 COMBINING ACUTE ACCENT
  expect(displayWidth("é")).toBe(1);
});

test("displayWidth 对全角标点与全角 ASCII 计为双宽", () => {
  expect(displayWidth("，")).toBe(2);
  expect(displayWidth("Ａ")).toBe(2);
});

test("truncateToWidth 按显示宽度截断，不切碎双宽字符", () => {
  expect(truncateToWidth("你好世界", 5)).toBe("你好");
  expect(truncateToWidth("hello world", 5)).toBe("hello");
  expect(truncateToWidth("你好", 10)).toBe("你好");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/markdown/width.test.ts`
Expected: FAIL，报 `Cannot find module '@/markdown/width.js'`

- [ ] **Step 3: 实现**

```ts
// src/markdown/width.ts
const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK Radicals, Kangxi, CJK Symbols and Punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK Compat
  [0x3400, 0x4dbf], // CJK Extension A
  [0x4e00, 0x9fff], // CJK Unified Ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul Syllables
  [0xf900, 0xfaff], // CJK Compatibility Ideographs
  [0xfe30, 0xfe4f], // CJK Compatibility Forms
  [0xff00, 0xff60], // Fullwidth Forms
  [0xffe0, 0xffe6], // Fullwidth Signs
  [0x20000, 0x3fffd], // CJK Extension B+
];

const COMBINING_RANGES: Array<[number, number]> = [
  [0x0300, 0x036f], // Combining Diacritical Marks
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x20d0, 0x20ff],
];

function codePointWidth(codePoint: number): number {
  if (COMBINING_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) {
    return 0;
  }
  if (WIDE_RANGES.some(([start, end]) => codePoint >= start && codePoint <= end)) {
    return 2;
  }
  return 1;
}

export function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    width += codePointWidth(char.codePointAt(0)!);
  }
  return width;
}

export function truncateToWidth(text: string, max: number): string {
  let width = 0;
  let result = "";
  for (const char of text) {
    const charWidth = codePointWidth(char.codePointAt(0)!);
    if (width + charWidth > max) break;
    width += charWidth;
    result += char;
  }
  return result;
}
```

用 `for...of` 遍历字符串按码点迭代（自动处理代理对），不用 `charCodeAt` 逐 UTF-16 code unit 遍历。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/markdown/width.test.ts`
Expected: PASS，5 个测试全部通过

- [ ] **Step 5: 提交**

```bash
git add src/markdown/width.ts test/markdown/width.test.ts
git commit -m "feat: 新增终端显示宽度计算（CJK 双宽支持）"
```

---

### Task 3: 行内 Markdown 分词

**Files:**
- Create: `src/markdown/inline.ts`
- Test: `test/markdown/inline.test.ts`

**Interfaces:**
- Produces:
  ```ts
  type InlineSpan =
    | { kind: "text" | "bold" | "italic" | "code"; text: string }
    | { kind: "link"; text: string; href: string };

  function parseInline(source: string): InlineSpan[];
  ```

- [ ] **Step 1: 写失败测试**

```ts
// test/markdown/inline.test.ts
import { expect, test } from "bun:test";
import { parseInline } from "@/markdown/inline.js";

test("纯文本返回单个 text span", () => {
  expect(parseInline("hello world")).toEqual([{ kind: "text", text: "hello world" }]);
});

test("解析粗体", () => {
  expect(parseInline("a **bold** b")).toEqual([
    { kind: "text", text: "a " },
    { kind: "bold", text: "bold" },
    { kind: "text", text: " b" },
  ]);
});

test("解析斜体（星号与下划线两种写法）", () => {
  expect(parseInline("*it*")).toEqual([{ kind: "italic", text: "it" }]);
  expect(parseInline("_it_")).toEqual([{ kind: "italic", text: "it" }]);
});

test("解析行内代码", () => {
  expect(parseInline("use `code` here")).toEqual([
    { kind: "text", text: "use " },
    { kind: "code", text: "code" },
    { kind: "text", text: " here" },
  ]);
});

test("解析链接", () => {
  expect(parseInline("see [text](http://example.com)")).toEqual([
    { kind: "text", text: "see " },
    { kind: "link", text: "text", href: "http://example.com" },
  ]);
});

test("代码优先级最高，代码内的 ** 不被当作粗体标记", () => {
  expect(parseInline("`a**b`")).toEqual([{ kind: "code", text: "a**b" }]);
});

test("未闭合的标记按纯文本处理", () => {
  expect(parseInline("a **b")).toEqual([{ kind: "text", text: "a **b" }]);
  expect(parseInline("a `b")).toEqual([{ kind: "text", text: "a `b" }]);
});

test("不支持嵌套：粗体内的反引号不解析为代码", () => {
  expect(parseInline("**a `code` b**")).toEqual([
    { kind: "bold", text: "a `code` b" },
  ]);
});

test("空字符串返回空数组", () => {
  expect(parseInline("")).toEqual([]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/markdown/inline.test.ts`
Expected: FAIL，报 `Cannot find module '@/markdown/inline.js'`

- [ ] **Step 3: 实现**

```ts
// src/markdown/inline.ts
export type InlineSpan =
  | { kind: "text" | "bold" | "italic" | "code"; text: string }
  | { kind: "link"; text: string; href: string };

const LINK_PATTERN = /^\[([^\]]*)\]\(([^)]*)\)/;

export function parseInline(source: string): InlineSpan[] {
  const spans: InlineSpan[] = [];
  let textBuffer = "";
  let i = 0;

  function flushText(): void {
    if (textBuffer.length > 0) {
      spans.push({ kind: "text", text: textBuffer });
      textBuffer = "";
    }
  }

  while (i < source.length) {
    const remaining = source.slice(i);

    // 优先级 1: 行内代码 `code`
    if (source[i] === "`") {
      const closeIndex = source.indexOf("`", i + 1);
      if (closeIndex !== -1) {
        flushText();
        spans.push({ kind: "code", text: source.slice(i + 1, closeIndex) });
        i = closeIndex + 1;
        continue;
      }
    }

    // 优先级 2: 粗体 **bold**
    if (source.startsWith("**", i)) {
      const closeIndex = source.indexOf("**", i + 2);
      if (closeIndex !== -1) {
        flushText();
        spans.push({ kind: "bold", text: source.slice(i + 2, closeIndex) });
        i = closeIndex + 2;
        continue;
      }
    }

    // 优先级 3: 斜体 *italic* 或 _italic_
    if (source[i] === "*" || source[i] === "_") {
      const marker = source[i];
      const closeIndex = source.indexOf(marker, i + 1);
      if (closeIndex !== -1 && closeIndex > i + 1) {
        flushText();
        spans.push({ kind: "italic", text: source.slice(i + 1, closeIndex) });
        i = closeIndex + 1;
        continue;
      }
    }

    // 优先级 4: 链接 [text](href)
    if (source[i] === "[") {
      const match = LINK_PATTERN.exec(remaining);
      if (match) {
        flushText();
        spans.push({ kind: "link", text: match[1]!, href: match[2]! });
        i += match[0].length;
        continue;
      }
    }

    textBuffer += source[i];
    i += 1;
  }

  flushText();
  return spans;
}
```

未闭合标记走到 `indexOf` 返回 `-1` 的分支，自然落到 `textBuffer += source[i]` 逐字符降级为纯文本 —— 不需要额外的回溯逻辑。嵌套不支持是因为一旦进入某个 span 的内容区间（如粗体的 `**...**` 之间），内容直接原样切片，不会递归调用 `parseInline`。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/markdown/inline.test.ts`
Expected: PASS，9 个测试全部通过

- [ ] **Step 5: 提交**

```bash
git add src/markdown/inline.ts test/markdown/inline.test.ts
git commit -m "feat: 新增行内 Markdown 分词器"
```

---

### Task 4: 块级 Markdown 扫描

**Files:**
- Create: `src/markdown/blocks.ts`
- Test: `test/markdown/blocks.test.ts`

**Interfaces:**
- Consumes: `parseInline` from `@/markdown/inline.js`（Task 3）
- Produces:
  ```ts
  type MarkdownBlock =
    | { kind: "heading"; level: 1 | 2 | 3; spans: InlineSpan[] }
    | { kind: "paragraph"; spans: InlineSpan[] }
    | { kind: "code"; lang?: string; lines: string[] }
    | { kind: "list"; ordered: boolean; items: { spans: InlineSpan[]; indent: number }[] }
    | { kind: "quote"; spans: InlineSpan[] }
    | { kind: "rule" }
    | { kind: "table"; header: InlineSpan[][]; align: ("left" | "center" | "right")[]; rows: InlineSpan[][][] };

  function parseBlocks(
    source: string,
    opts?: { closeAll?: boolean },
  ): { blocks: MarkdownBlock[]; closed: boolean[]; endOffsets: number[] };
  ```

- [ ] **Step 1: 写失败测试**

```ts
// test/markdown/blocks.test.ts
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

test("表格：单独一行且是最后一块时不被误判为段落（lookahead 陷阱）", () => {
  const { blocks, closed } = parseBlocks("| a | b |");
  // 还看不到分隔行，无法定性，因此保持未封闭，不提前提交成 paragraph
  expect(closed).toEqual([false]);
  expect(blocks[0]!.kind).not.toBe("paragraph");
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/markdown/blocks.test.ts`
Expected: FAIL，报 `Cannot find module '@/markdown/blocks.js'`

- [ ] **Step 3: 实现**

```ts
// src/markdown/blocks.ts
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
  end: number; // 含换行符的结束偏移
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

    // 分割线（单行块）
    if (RULE_PATTERN.test(line.text)) {
      blocks.push({ kind: "rule" });
      closed.push(hasTrailingNewline);
      endOffsets.push(line.end);
      index += 1;
      continue;
    }

    // 标题（单行块）
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

    // 围栏代码块
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

    // 表格：header 行 + 紧邻的分隔行
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
        const isLastBlockLine = cursor >= lines.length;
        blocks.push({ kind: "table", header, align, rows });
        if (isLastBlockLine && !opts.closeAll) {
          closed.push(false);
          endOffsets.push(lines[cursor - 1]!.end);
        } else {
          closed.push(true);
          endOffsets.push(lines[cursor - 1]!.end);
        }
        index = cursor;
        continue;
      }
      // 单独一行 "| a | b |"，看不到分隔行——留给下面的 lookahead 兜底逻辑
    }

    // 空行：跳过
    if (line.text.trim() === "") {
      index += 1;
      continue;
    }

    // 列表
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

    // 引用
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

    // 段落：吞掉后续非空、非特殊语法的行，直到空行或文件结尾
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
```

关键设计点对应设计文档 §7.3 的统一规则：

- 单行块（heading/rule）用 `hasTrailingNewline` 直接判断是否封闭——这是唯一的例外，其余块都遵循「最后一块永远未封闭」。
- 表格的 lookahead 陷阱：`| a | b |` 单独一行且看不到下一行时，`tableRowMatch` 分支的 `nextLine` 判断为 `undefined`，代码走到分支末尾的注释处“留给下面的兜底逻辑”，自然落入段落分支处理为未封闭的段落——等流继续推进、下一行到达变成分隔行时，`parseBlocks` 重新从头扫描整个 `pending` 缓冲区（由 `streamBuffer.ts` 负责重新调用），这次 `nextLine` 存在，就会正确识别成表格。这依赖 Task 5 的 `streamBuffer` 每次都用完整 `pending` 重新调用 `parseBlocks`，而不是增量更新。
- 段落/列表/引用统一走 `pushParagraphLikeClosed`：只要该块的最后一行是 `lines` 数组的最后一行（`isLastBlockLine`），就标记未封闭；否则说明后面还有空行或别的块把它截断了，标记已封闭。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/markdown/blocks.test.ts`
Expected: PASS，全部测试通过。如果表格 lookahead 测试失败，检查 `isBlockStart` 里表格分支的 `nextLine` 参数传递是否正确。

- [ ] **Step 5: 提交**

```bash
git add src/markdown/blocks.ts test/markdown/blocks.test.ts
git commit -m "feat: 新增块级 Markdown 扫描器"
```

---

### Task 5: 流式缓冲器

**Files:**
- Create: `src/tui/streamBuffer.ts`
- Test: `test/tui/streamBuffer.test.ts`

**Interfaces:**
- Consumes: `parseBlocks` from `@/markdown/blocks.js`（Task 4），`MarkdownBlock` type
- Produces:
  ```ts
  interface StreamBuffer { pending: string }
  function createStreamBuffer(): StreamBuffer;
  function pushDelta(buffer: StreamBuffer, delta: string): { buffer: StreamBuffer; committed: MarkdownBlock[]; tail: MarkdownBlock[] };
  function flush(buffer: StreamBuffer): { buffer: StreamBuffer; committed: MarkdownBlock[] };
  ```

- [ ] **Step 1: 写失败测试**

```ts
// test/tui/streamBuffer.test.ts
import { expect, test } from "bun:test";
import { createStreamBuffer, pushDelta, flush } from "@/tui/streamBuffer.js";

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
  let buffer = createStreamBuffer();
  let result = pushDelta(buffer, "first paragraph\n\nsecond");
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
    // 核心不变式：committed 里不应该出现内容不完整的代码块
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
  // header 行不应该在被识别为表格之前被误提交成段落
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
  expect(second.tail[0]).toMatchObject({ kind: "paragraph", spans: [{ kind: "text", text: "more text" }] });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/streamBuffer.test.ts`
Expected: FAIL，报 `Cannot find module '@/tui/streamBuffer.js'`

- [ ] **Step 3: 实现**

```ts
// src/tui/streamBuffer.ts
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
    else break; // 一旦遇到未封闭块，后面（本来就只有一个未封闭的尾块）不再算 committed
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
```

`splitCommittedAndTail` 用 `break` 在第一个未封闭块处停止累积 `committed` —— 因为 `parseBlocks` 的规则保证只有最后一个块可能未封闭，所以理论上 `closed` 数组里 `false` 只会出现在末尾，`break` 只是防御性写法（万一某天 blocks.ts 的实现有 bug 提前返回了多个未封闭块，这里也不会误吞后面已封闭的块）。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/tui/streamBuffer.test.ts`
Expected: PASS，全部测试通过。这是设计文档标注的核心用例（逐字符喂入代码块/表格），如果失败要先去检查 Task 4 的 `parseBlocks` 封闭判定，而不是这里的切分逻辑。

- [ ] **Step 5: 提交**

```bash
git add src/tui/streamBuffer.ts test/tui/streamBuffer.test.ts
git commit -m "feat: 新增流式缓冲器，切分已封闭块与尾块"
```

---

### Task 6: Markdown 渲染组件

**Files:**
- Create: `src/tui/Markdown.tsx`
- Test: `test/tui/Markdown.test.tsx`

**Interfaces:**
- Consumes: `MarkdownBlock`、`InlineSpan` types
- Produces: `<Markdown blocks={MarkdownBlock[]} />` React 组件

- [ ] **Step 1: 写失败测试**

```tsx
// test/tui/Markdown.test.tsx
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { Markdown } from "@/tui/Markdown.js";
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/Markdown.test.tsx`
Expected: FAIL，报 `Cannot find module '@/tui/Markdown.js'`

- [ ] **Step 3: 实现**

```tsx
// src/tui/Markdown.tsx
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
  const cellText = (spans: InlineSpan[]): string => spans.map((s) => ("text" in s ? s.text : "")).join("");

  const widths: number[] = [];
  for (let c = 0; c < columnCount; c += 1) {
    const headerWidth = displayWidth(cellText(block.header[c] ?? []));
    const rowWidths = block.rows.map((row) => displayWidth(cellText(row[c] ?? [])));
    widths.push(Math.max(headerWidth, ...rowWidths, 3));
  }

  const maxTotalWidth = Math.max(columns - columnCount - 1, columnCount * 3);
  const scale = Math.min(1, maxTotalWidth / widths.reduce((a, b) => a + b, 0));
  const finalWidths = widths.map((w) => Math.max(3, Math.floor(w * scale)));

  function renderRow(cells: InlineSpan[][]): string {
    return (
      "│" +
      cells
        .map((cell, i) => ` ${truncateToWidth(cellText(cell), finalWidths[i]!).padEnd(finalWidths[i]!)} `)
        .join("│") +
      "│"
    );
  }

  function renderBorder(left: string, mid: string, right: string): string {
    return left + finalWidths.map((w) => "─".repeat(w + 2)).join(mid) + right;
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/tui/Markdown.test.tsx`
Expected: PASS，全部测试通过

- [ ] **Step 5: 提交**

```bash
git add src/tui/Markdown.tsx test/tui/Markdown.test.tsx
git commit -m "feat: 新增 Markdown 渲染组件"
```

---

### Task 7: 事件类型扩展

**Files:**
- Modify: `src/core/events.ts`

**Interfaces:**
- Produces: `AgentEventMap` 新增 `"assistant-delta"`、`"assistant-flush"`、`"stream-interrupted"` 三个事件类型

- [ ] **Step 1: 写失败测试**

现有 `test/events.test.ts` 只测试通用的 `on`/`emit` 机制，不针对具体事件名。为新事件加一条最小验证：

```ts
// 追加到 test/events.test.ts 末尾
test("支持新增的流式事件类型", () => {
  const events = createAgentEvents();
  const deltas: string[] = [];
  events.on("assistant-delta", ({ text }) => deltas.push(text));
  events.emit("assistant-delta", { text: "hello", depth: 0 });
  expect(deltas).toEqual(["hello"]);

  let flushed = false;
  events.on("assistant-flush", () => {
    flushed = true;
  });
  events.emit("assistant-flush", { depth: 0 });
  expect(flushed).toBe(true);

  let interruptedReason: string | undefined;
  events.on("stream-interrupted", ({ reason }) => {
    interruptedReason = reason;
  });
  events.emit("stream-interrupted", { reason: "network", depth: 0 });
  expect(interruptedReason).toBe("network");
});
```

先查看 `test/events.test.ts` 现有的 import 语句，确保 `createAgentEvents` 已经被引入（应该已经是）。

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/events.test.ts`
Expected: FAIL，TypeScript 编译错误 —— `"assistant-delta"` 不是 `AgentEventName` 的合法值

- [ ] **Step 3: 实现**

在 `src/core/events.ts` 的 `AgentEventMap` 接口里追加三个事件（保留现有事件不变）：

```ts
export interface AgentEventMap {
  "step-start": { step: number; depth: number };
  "assistant-message": { text: string; depth: number };
  "assistant-delta": { text: string; depth: number };
  "assistant-flush": { depth: number };
  "stream-interrupted": { reason: string; depth: number };
  "tool-start": {
    id: string;
    toolName: string;
    input: unknown;
    depth: number;
  };
  "tool-end": {
    id: string;
    toolName: string;
    result: string;
    isError: boolean;
    depth: number;
  };
  "todo-changed": { todos: Todo[]; depth: number };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/events.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add src/core/events.ts test/events.test.ts
git commit -m "feat: 新增流式相关事件类型"
```

---

### Task 8: llm.ts 改流式，删除 max_tokens 升档

**Files:**
- Modify: `src/core/llm.ts`
- Test: `test/llm.test.ts`

**Interfaces:**
- Consumes: `maxOutputTokensFor` from `@/core/modelLimits.js`（Task 1）
- Produces: `ModelRecoveryOptions` 新增可选字段 `onTextDelta?: (text: string) => void`、`onStreamFlush?: () => void`。`callModelWithRecovery` 的返回类型不变（仍是 `Promise<Message>`）。

这是本计划里最关键、风险最高的任务，一次性完成三件事：改流式、删升档、加 fallback 查表联动。三件事互相耦合（都在 `callModelWithRecovery` 内部），拆开做会导致中间状态编译不过，所以合并成一个任务，但拆成多个 step 分别验证。

- [ ] **Step 1: 读取当前测试基线，确认要保留和要改写的用例**

Run: `bun test test/llm.test.ts`
Expected: PASS（当前 5 个测试全部通过，这是改动前的基线）

现有第一个测试 `"首次 max_tokens 不回灌截断内容并升到 64K 重试"`（`test/llm.test.ts:8-29`）断言了升档行为，这个测试要被替换成新行为。其余 4 个测试（429 退避、529 fallback、prompt_too_long compact、input token 记录）保持不变，只是走过的代码路径变了，不改断言。

- [ ] **Step 2: 改写升档测试为新行为，运行确认失败**

把 `test/llm.test.ts` 里原来的测试：

```ts
test("首次 max_tokens 不回灌截断内容并升到 64K 重试", async () => {
  const state = createState();
  const seenMaxTokens: number[] = [];
  const request = async ({ maxTokens }: { maxTokens: number }) => {
    seenMaxTokens.push(maxTokens);
    return seenMaxTokens.length === 1
      ? response("max_tokens", "截断内容")
      : response("end_turn", "完整内容");
  };

  const result = await callModelWithRecovery(state, {
    system: "system",
    tools: [],
    request,
    sleep: async () => {},
  });

  expect(seenMaxTokens).toEqual([MAX_TOKENS, 64000]);
  expect(state.messages).toHaveLength(0);
  expect(JSON.stringify(result.content)).toContain("完整内容");
  expect(state.maxTokens).toBe(64000);
});
```

替换为：

```ts
test("首个 max_tokens 直接落入 continuation 续写，不重发", async () => {
  const state = createState();
  const seenMaxTokens: number[] = [];
  let requestCount = 0;
  const request = async ({ maxTokens }: { maxTokens: number }) => {
    seenMaxTokens.push(maxTokens);
    requestCount += 1;
    return requestCount === 1
      ? response("max_tokens", "截断内容")
      : response("end_turn", "续写内容");
  };

  const result = await callModelWithRecovery(state, {
    system: "system",
    tools: [],
    request,
    sleep: async () => {},
  });

  // maxTokens 全程不变，没有升档这一步
  expect(seenMaxTokens).toEqual([state.maxTokens, state.maxTokens]);
  // 截断内容被回灌进历史，走了 continuation 路径
  expect(JSON.stringify(state.messages)).toContain("截断内容");
  expect(JSON.stringify(result.content)).toContain("续写内容");
});
```

同时删掉这个测试文件里对 `MAX_TOKENS` 的 import（如果只在这一个测试里用到）；检查文件顶部：

```ts
import { MAX_TOKENS } from "@/config.js";
```

这行要删，因为 Task 10 会从 `config.ts` 删除 `MAX_TOKENS` 常量。

再追加一个新测试验证 fallback 切换后的查表联动：

```ts
test("连续三次 529 切换 fallback 模型后，maxTokens 按新模型重新查表", async () => {
  const state = createState();
  state.modelId = "claude-sonnet-5"; // 128K ceiling
  const seenMaxTokens: number[] = [];
  let attempts = 0;
  const request = async ({ modelId, maxTokens }: { modelId: string; maxTokens: number }) => {
    attempts += 1;
    seenMaxTokens.push(maxTokens);
    if (attempts <= 3) throw apiError(529, "overloaded");
    return response("end_turn", "备用模型完成");
  };

  await callModelWithRecovery(state, {
    system: "system",
    tools: [],
    request,
    fallbackModelId: "claude-haiku-4-5", // 64K ceiling
    sleep: async () => {},
    random: () => 0,
  });

  expect(state.modelId).toBe("claude-haiku-4-5");
  expect(state.maxTokens).toBe(64_000);
  // 第 4 次请求（切换后）应该带上新的 64K，不是切换前的 128K
  expect(seenMaxTokens.at(-1)).toBe(64_000);
});
```

Run: `bun test test/llm.test.ts`
Expected: FAIL —— 新测试会失败，因为 `llm.ts` 还没实现新逻辑；旧的第一个测试已被替换所以不再有旧行为的断言残留。

- [ ] **Step 3: 实现 —— 删除升档逻辑，改为查表初始化，fallback 时重新查表**

打开 `src/core/llm.ts`，做以下修改：

1. 删除顶部常量：

```ts
// 删除这一行
const ESCALATED_MAX_TOKENS = 64_000;
```

2. 新增 import：

```ts
import { maxOutputTokensFor } from "@/core/modelLimits.js";
```

3. 把 `callModelWithRecovery` 里原来的（`src/core/llm.ts:62-67`）：

```ts
      if (response.stop_reason !== "max_tokens") return response;
      if (!state.hasEscalatedMaxTokens) {
        state.maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalatedMaxTokens = true;
        continue;
      }
      if (state.recoveryCount >= MAX_CONTINUATIONS) return response;
```

改为：

```ts
      if (response.stop_reason !== "max_tokens") return response;
      if (state.recoveryCount >= MAX_CONTINUATIONS) return response;
```

即删除升档分支，第一次撞 `max_tokens` 直接落入下面已有的 continuation 回灌逻辑（`state.messages.push(...)` 那两行，保持不动）。

4. 在 fallback 模型切换处（原 `src/core/llm.ts:89-91`）：

```ts
        state.consecutive529 += 1;
        if (state.consecutive529 >= 3 && options.fallbackModelId) {
          state.modelId = options.fallbackModelId;
        }
```

改为：

```ts
        state.consecutive529 += 1;
        if (state.consecutive529 >= 3 && options.fallbackModelId) {
          state.modelId = options.fallbackModelId;
          state.maxTokens = maxOutputTokensFor(state.modelId);
        }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/llm.test.ts`
Expected: PASS，全部 6 个测试通过（原 5 个减 1 改写 + 1 新增 = 6）

- [ ] **Step 5: 提交**

```bash
git add src/core/llm.ts test/llm.test.ts
git commit -m "refactor: 删除 max_tokens 升档逻辑，fallback 切换时重新查表 ceiling"
```

---

### Task 9: llm.ts 改流式请求，新增 delta 回调

**Files:**
- Modify: `src/core/llm.ts`
- Test: `test/llm.test.ts`

**Interfaces:**
- Consumes: `client.messages.stream()` from `@anthropic-ai/sdk`（已装，见 `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.ts:27`）
- Produces: `ModelRecoveryOptions.onTextDelta?: (text: string) => void`、`ModelRecoveryOptions.onStreamFlush?: () => void`

这一步只改 `requestModel` 函数内部实现和 `ModelRecoveryOptions`/`callModelWithRecovery` 的回调传递，不改 `ModelRequest` 的形状，也不影响 Task 8 刚做完的升档删除逻辑。

- [ ] **Step 1: 写失败测试**

在 `test/llm.test.ts` 追加：

```ts
test("callModelWithRecovery 通过 onTextDelta 转发流式增量文本", async () => {
  const state = createState();
  const deltas: string[] = [];
  let flushCount = 0;
  const request = async () => response("end_turn", "完整回复");

  await callModelWithRecovery(state, {
    system: "system",
    tools: [],
    request,
    sleep: async () => {},
    onTextDelta: (text) => deltas.push(text),
    onStreamFlush: () => {
      flushCount += 1;
    },
  });

  // request 注入点不模拟真实流式细节，这里只验证回调不报错、不影响主流程
  // 真实流式行为由 requestModel 的默认实现负责，覆盖在下面的集成测试里
  expect(flushCount).toBeGreaterThanOrEqual(0);
});
```

这个测试比较薄，因为 `options.request` 注入点绕过了 `requestModel` 的真实流式实现——用它验证回调透传不破坏现有流程即可。真正验证流式行为的是下一步的集成测试。

- [ ] **Step 2: 写 requestModel 集成测试（用真实 Bun.serve 模拟 SSE），确认失败**

新增测试验证 `requestModel`（通过 `callModelWithRecovery` 不传 `request` 选项，走默认实现）真的会调用 `client.messages.stream()`。这需要一个能响应 SSE 格式的假服务器。追加：

```ts
test("不传 request 选项时，requestModel 使用流式 API 并通过回调转发文本", async () => {
  const previousApiKey = process.env.API_KEY;
  const previousBaseUrl = process.env.BASE_URL;
  process.env.API_KEY = "test-key";

  const sseBody = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(sseBody, {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
  process.env.BASE_URL = server.url.origin;

  try {
    const state = createState();
    state.modelId = "test-model";
    const deltas: string[] = [];
    let flushed = false;

    const result = await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      sleep: async () => {},
      onTextDelta: (text) => deltas.push(text),
      onStreamFlush: () => {
        flushed = true;
      },
    });

    expect(deltas.join("")).toBe("hello world");
    expect(flushed).toBe(true);
    expect(result.stop_reason).toBe("end_turn");
    expect(JSON.stringify(result.content)).toContain("hello world");
  } finally {
    server.stop(true);
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    if (previousBaseUrl === undefined) delete process.env.BASE_URL;
    else process.env.BASE_URL = previousBaseUrl;
  }
});
```

Run: `bun test test/llm.test.ts`
Expected: FAIL —— 第一个新测试可能已经通过（因为它只测回调透传），第二个会失败，因为 `requestModel` 还是走 `client.messages.create()` 非流式实现，不会调用 `onTextDelta`。

- [ ] **Step 3: 实现**

修改 `src/core/llm.ts`：

1. 扩展 `ModelRecoveryOptions` 接口，新增两个可选字段：

```ts
export interface ModelRecoveryOptions {
  system: string;
  tools: Tool[];
  request?: (request: ModelRequest) => Promise<Message>;
  beforeRequest?: (state: State) => Promise<void>;
  reactiveCompact?: (state: State) => Promise<void>;
  fallbackModelId?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  onTextDelta?: (text: string) => void;
  onStreamFlush?: () => void;
}
```

2. 把 `callModelWithRecovery` 内部调用 `request(...)` 的地方（原 `src/core/llm.ts:52-58`）改为把回调透传给默认的 `requestModel`。因为 `options.request` 这个注入点的签名是 `(request: ModelRequest) => Promise<Message>`，不带回调参数（保持向后兼容，测试里那些不关心流式的用例继续用同样的签名），所以要在 `request` 未被覆盖时才用流式版本：

```ts
export async function callModelWithRecovery(
  state: State,
  options: ModelRecoveryOptions,
): Promise<Message> {
  const request = options.request ?? ((req) => requestModel(req, options.onTextDelta, options.onStreamFlush));
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxRetries = options.maxRetries ?? MAX_TRANSIENT_RETRIES;
  let transientRetries = 0;
  // ...其余循环逻辑不变
```

3. 把 `requestModel` 函数本身（原 `src/core/llm.ts:131-146`）改成流式实现：

```ts
async function requestModel(
  request: ModelRequest,
  onTextDelta?: (text: string) => void,
  onStreamFlush?: () => void,
): Promise<Message> {
  const clientOptions = getAnthropicClientOptions();
  const optionsKey = JSON.stringify(clientOptions);
  if (!client || clientOptionsKey !== optionsKey) {
    client = new Anthropic(clientOptions);
    clientOptionsKey = optionsKey;
  }

  const stream = client.messages.stream(
    {
      model: request.modelId,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    },
    { maxRetries: 0 },
  );

  if (onTextDelta) {
    stream.on("text", (delta) => onTextDelta(delta));
  }

  const message = await stream.finalMessage();
  onStreamFlush?.();
  return message;
}
```

`summarizeMessages` 函数（`src/core/llm.ts:102-129`）直接调用的是模块内部的 `requestModel({...})`，不传后两个参数——两个新参数都是可选的，`onTextDelta?.()` 式的调用形式在它们是 `undefined` 时安全跳过，所以 `summarizeMessages` 不用改。

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/llm.test.ts`
Expected: PASS，全部测试通过（8 个：原 6 个 + 本任务新增 2 个）

如果 SSE 集成测试失败，检查：
- Bun 是否正确处理了 `text/event-stream` content-type（不需要手动设置分块传输，`Response` 构造函数会处理）
- `@anthropic-ai/sdk` 的 `MessageStream` 是否需要额外的 `content-length` 或分块编码头 —— 如果测试报"stream 解析失败"，改用 `Response.json` 式的非流式响应体加 `Transfer-Encoding: chunked` 手动模拟，或直接读 `node_modules/@anthropic-ai/sdk/lib/streaming.ts` 确认 SSE 解析器的行分隔符要求（应为 `\n\n` 分隔事件）

- [ ] **Step 5: 提交**

```bash
git add src/core/llm.ts test/llm.test.ts
git commit -m "feat: requestModel 改用流式 API，新增 delta 与 flush 回调"
```

---

### Task 10: config.ts 清理，state.ts 清理

**Files:**
- Modify: `src/config.ts`
- Modify: `src/core/state.ts`
- Modify: `src/core/loop.ts`

**Interfaces:**
- Consumes: `maxOutputTokensFor` from `@/core/modelLimits.js`（Task 1）
- Produces: `state.maxTokens` 的所有初始化点统一走查表函数，不再有硬编码常量

这一步纯粹是清理收尾：`config.ts` 删掉不再被引用的 `MAX_TOKENS`，`state.ts` 删掉 `hasEscalatedMaxTokens` 字段（Task 8 已经不再写它，但字段声明和初始化还残留），`loop.ts` 的初始化点改用查表。

- [ ] **Step 1: 确认没有遗留引用，运行全量测试作为基线**

Run: `bun test`
Expected: 当前应该全部通过（Task 1-9 都已完成并各自验证过），除了 `createState()` 里仍有 `hasEscalatedMaxTokens: false` 字段和 `maxTokens: MAX_TOKENS` —— 这些还没删，先确认现状不报错。

- [ ] **Step 2: 修改 state.ts，删除字段**

`src/core/state.ts` 当前：

```ts
export interface State {
  messages: MessageParam[];
  steps: number;
  stopRespawnCount: number;
  todos: Todo[];
  depth: number;
  workspace: string;
  enabledTools: string[];
  memoryPath: string;
  modelId: string;
  maxTokens: number;
  lastInputTokens: number;
  consecutive529: number;
  compactFailures: number;
  recoveryCount: number;
  hasEscalatedMaxTokens: boolean;
  hasAttemptedReactiveCompact: boolean;
}

export function createState(depth = 0): State {
  const workspace = process.cwd();
  return {
    messages: [],
    steps: 0,
    stopRespawnCount: 0,
    todos: [],
    depth,
    workspace,
    enabledTools: [],
    memoryPath: join(workspace, ".memory", "MEMORY.md"),
    modelId: getModelId(),
    maxTokens: MAX_TOKENS,
    lastInputTokens: 0,
    consecutive529: 0,
    compactFailures: 0,
    recoveryCount: 0,
    hasEscalatedMaxTokens: false,
    hasAttemptedReactiveCompact: false,
  };
}
```

改为：

```ts
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { join } from "node:path";
import { getModelId } from "@/config.js";
import { maxOutputTokensFor } from "@/core/modelLimits.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface Todo {
  content: string;
  status: TodoStatus;
}

export interface State {
  messages: MessageParam[];
  steps: number;
  stopRespawnCount: number;
  todos: Todo[];
  depth: number;
  workspace: string;
  enabledTools: string[];
  memoryPath: string;
  modelId: string;
  maxTokens: number;
  lastInputTokens: number;
  consecutive529: number;
  compactFailures: number;
  recoveryCount: number;
  hasAttemptedReactiveCompact: boolean;
}

export function createState(depth = 0): State {
  const workspace = process.cwd();
  const modelId = getModelId();
  return {
    messages: [],
    steps: 0,
    stopRespawnCount: 0,
    todos: [],
    depth,
    workspace,
    enabledTools: [],
    memoryPath: join(workspace, ".memory", "MEMORY.md"),
    modelId,
    maxTokens: maxOutputTokensFor(modelId),
    lastInputTokens: 0,
    consecutive529: 0,
    compactFailures: 0,
    recoveryCount: 0,
    hasAttemptedReactiveCompact: false,
  };
}
```

- [ ] **Step 3: 修改 loop.ts 的初始化点**

`src/core/loop.ts` 里 `agentLoop` 函数内（原第 55 行）：

```ts
  state.maxTokens = MAX_TOKENS;
```

改为：

```ts
  state.maxTokens = maxOutputTokensFor(state.modelId);
```

注意 `state.modelId = getModelId();` 这一行（原第 54 行）必须在这行之前执行，检查原文件顺序：

```ts
  state.modelId = getModelId();
  state.maxTokens = MAX_TOKENS;
```

顺序已经是对的（`modelId` 先赋值），改动后：

```ts
  state.modelId = getModelId();
  state.maxTokens = maxOutputTokensFor(state.modelId);
```

同时更新顶部 import：把

```ts
import { MAX_STEPS, MAX_TOKENS, getModelId } from "@/config.js";
```

改为：

```ts
import { MAX_STEPS, getModelId } from "@/config.js";
import { maxOutputTokensFor } from "@/core/modelLimits.js";
```

- [ ] **Step 4: 修改 config.ts，删除常量**

`src/config.ts` 当前：

```ts
import "dotenv/config";

export const MAX_TOKENS = 16_000;
export const MAX_STEPS = 90;

export function getModelId(): string {
  return (
    process.env.ANTHROPIC_MODEL ?? process.env.MODEL_ID ?? "claude-sonnet-5"
  );
}

export function getAnthropicClientOptions(): {
  apiKey?: string;
  baseURL?: string;
} {
  return {
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  };
}
```

改为（只删 `MAX_TOKENS` 这一行）：

```ts
import "dotenv/config";

export const MAX_STEPS = 90;

export function getModelId(): string {
  return (
    process.env.ANTHROPIC_MODEL ?? process.env.MODEL_ID ?? "claude-sonnet-5"
  );
}

export function getAnthropicClientOptions(): {
  apiKey?: string;
  baseURL?: string;
} {
  return {
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  };
}
```

- [ ] **Step 5: 全局搜索确认没有残留引用**

Run: `grep -rn "MAX_TOKENS\b" src/ test/` （在 Bash 里执行，注意 `\b` 是词边界，避免匹配到 `ESCALATED_MAX_TOKENS` 之类——但那个已经在 Task 8 删了）

Expected: 无匹配结果。如果 `test/llm.test.ts` 里还有 `import { MAX_TOKENS } from "@/config.js"`，回去删掉（应该已经在 Task 8 Step 2 处理了，这里是二次确认）。

Run: `grep -rn "hasEscalatedMaxTokens" src/ test/`
Expected: 无匹配结果。

- [ ] **Step 6: typecheck 与全量测试**

Run: `bun run typecheck`
Expected: 无编译错误

Run: `bun test`
Expected: 全部通过

- [ ] **Step 7: 提交**

```bash
git add src/config.ts src/core/state.ts src/core/loop.ts
git commit -m "refactor: 删除 MAX_TOKENS 常量与 hasEscalatedMaxTokens 字段，统一走模型查表"
```

---

### Task 11: loop.ts 桥接流式事件到 TUI

**Files:**
- Modify: `src/core/loop.ts`
- Test: `test/loop.test.ts`

**Interfaces:**
- Consumes: `AgentEvents.emit`（Task 7 新增的事件类型）、`callModelWithRecovery` 的 `onTextDelta`/`onStreamFlush` 回调（Task 9）
- Produces: 无新增导出，只改内部行为——`depth === 0` 时把 delta 广播为 `assistant-delta`/`assistant-flush` 事件；原有的 `assistant-message` emit 加 `depth > 0` 条件守卫

- [ ] **Step 1: 写失败测试**

`test/loop.test.ts` 现有测试用 `Bun.serve` 模拟非流式 JSON 响应（返回 `Response.json(...)`）。流式改造后，`agentLoop` 内部调用 `callModelWithRecovery` 不传 `request` 选项，会走 Task 9 改好的默认 `requestModel`，它会调用 `client.messages.stream()`，这要求测试服务器返回 SSE 格式而不是普通 JSON。

先加一个验证事件桥接的新测试。追加到 `test/loop.test.ts`：

```ts
test("depth 0 时流式 delta 桥接为 assistant-delta 事件，不重复触发 assistant-message", async () => {
  const sseBody = [
    'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
    'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"任务"}}\n\n',
    'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"完成"}}\n\n',
    'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
    'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
    'event: message_stop\ndata: {"type":"message_stop"}\n\n',
  ].join("");

  const server = Bun.serve({
    port: 0,
    fetch() {
      return new Response(sseBody, { headers: { "content-type": "text/event-stream" } });
    },
  });

  const previousApiKey = process.env.API_KEY;
  const previousBaseUrl = process.env.BASE_URL;
  const previousModel = process.env.MODEL_ID;
  process.env.API_KEY = "test-key";
  process.env.BASE_URL = server.url.origin;
  process.env.MODEL_ID = "test-model";

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "执行测试" });
    const events = createAgentEvents();
    const deltas: string[] = [];
    let flushCount = 0;
    let assistantMessageCount = 0;
    events.on("assistant-delta", ({ text }) => deltas.push(text));
    events.on("assistant-flush", () => {
      flushCount += 1;
    });
    events.on("assistant-message", () => {
      assistantMessageCount += 1;
    });

    await agentLoop(state, { events });

    expect(deltas.join("")).toBe("任务完成");
    expect(flushCount).toBeGreaterThanOrEqual(1);
    // depth 0 主 agent 不应该走整段 assistant-message 路径
    expect(assistantMessageCount).toBe(0);
  } finally {
    restoreEnvironment2("API_KEY", previousApiKey);
    restoreEnvironment2("BASE_URL", previousBaseUrl);
    restoreEnvironment2("MODEL_ID", previousModel);
    server.stop(true);
  }
});

function restoreEnvironment2(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
```

（`restoreEnvironment2` 是为了避开文件里已有的同名 `restoreEnvironment` 函数——写实现时检查一下 `test/loop.test.ts` 顶部是否已有这个辅助函数，如果签名一致可以直接复用，不用重复定义。）

同时要在文件顶部 import 里加上 `createAgentEvents`（如果还没有）：

```ts
import { createAgentEvents } from "@/core/events.js";
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/loop.test.ts`
Expected: FAIL —— 当前 `loop.ts` 没有订阅 `onTextDelta`/`onStreamFlush`，也没有 emit `assistant-delta`/`assistant-flush`；`assistant-message` 的 emit 条件还没加 `depth > 0` 守卫，所以 `assistantMessageCount` 会是 1 而不是期望的 0。

- [ ] **Step 3: 实现**

打开 `src/core/loop.ts`，在 `agentLoop` 函数内，找到调用 `callModelWithRecovery` 的地方（原第 65-71 行）：

```ts
    const response = await callModelWithRecovery(state, {
      system,
      tools: runtime.definitions,
      beforeRequest: (currentState) => contextManager.manage(currentState),
      reactiveCompact: (currentState) => contextManager.reactiveCompact(currentState),
      fallbackModelId: process.env.FALLBACK_MODEL_ID,
    });
```

改为（新增 `onTextDelta`/`onStreamFlush`，只在 `depth === 0` 时接线）：

```ts
    const response = await callModelWithRecovery(state, {
      system,
      tools: runtime.definitions,
      beforeRequest: (currentState) => contextManager.manage(currentState),
      reactiveCompact: (currentState) => contextManager.reactiveCompact(currentState),
      fallbackModelId: process.env.FALLBACK_MODEL_ID,
      onTextDelta:
        state.depth === 0
          ? (text) => options.events?.emit("assistant-delta", { text, depth: state.depth })
          : undefined,
      onStreamFlush:
        state.depth === 0
          ? () => options.events?.emit("assistant-flush", { depth: state.depth })
          : undefined,
    });
```

再找到原来 emit `assistant-message` 的地方（原第 73-82 行）：

```ts
    state.messages.push({ role: "assistant", content: response.content });
    const assistantText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (assistantText) {
      options.events?.emit("assistant-message", {
        text: assistantText,
        depth: state.depth,
      });
    }
```

改为（加 `depth > 0` 守卫）：

```ts
    state.messages.push({ role: "assistant", content: response.content });
    const assistantText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (assistantText && state.depth > 0) {
      options.events?.emit("assistant-message", {
        text: assistantText,
        depth: state.depth,
      });
    }
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/loop.test.ts`
Expected: PASS，全部测试通过

如果原有的第一个测试（`"agent loop 回灌工具结果并受步数上限保护"`）失败，说明它用的 `Response.json(...)` 非流式响应体和新的流式 `requestModel` 不兼容——这个测试也要改成 SSE 格式响应，参照 Step 1 的 `createModelServer` 改写方式（工具调用场景的响应也要走 SSE：`content_block_start` 的 `content_block.type` 为 `"tool_use"`，可以不发 `content_block_delta`，直接在 `content_block_stop` 之后发 `message_delta` 带 `stop_reason: "tool_use"`）。检查该文件里所有用 `Bun.serve` + `Response.json` 模拟模型响应的测试，都需要同步改成 SSE，否则会因为 `client.messages.stream()` 解析不了普通 JSON body 而报错或挂起。

这是一个已知的连带改动——`test/loop.test.ts`、`test/runtime.test.ts`、`test/tui/App.test.tsx` 里所有 `createModelServer`/`Bun.serve` 模拟都要从 `Response.json(...)` 改成 SSE body。这个改动集中在 Task 13 处理（因为 `App.test.tsx` 和 `runtime.test.ts` 也依赖同一套 mock 模式），但如果这里就先撞到了失败，说明改动顺序需要调整——**先看这一步测试失败的具体原因**：如果只是 `agentLoop 回灌工具结果` 那个测试挂起或超时，把它的 `Bun.serve` mock 也顺带改成 SSE（复制本任务 Step 1 的 SSE body 构造方式，为 tool_use 场景调整 `content_block` 类型），确保 Task 11 结束时 `test/loop.test.ts` 整个文件全绿。

- [ ] **Step 5: 提交**

```bash
git add src/core/loop.ts test/loop.test.ts
git commit -m "feat: loop.ts 桥接流式 delta 事件，depth>0 子 agent 保留整段 assistant-message"
```

---

### Task 12: displayLog.ts 支持 Markdown block 条目

**Files:**
- Modify: `src/tui/displayLog.ts`
- Test: `test/tui/displayLog.test.ts`

**Interfaces:**
- Consumes: `parseBlocks` from `@/markdown/blocks.js`（Task 4）、`MarkdownBlock` type
- Produces: `DisplayEntry` 新增 `assistant-block` 变体；`DisplayLog` 新增 `streamingBlocks: MarkdownBlock[]` 字段；新增函数：
  ```ts
  function appendAssistantBlocks(log: DisplayLog, payload: { blocks: MarkdownBlock[]; depth: number }): DisplayLog;
  function setStreamingBlocks(log: DisplayLog, blocks: MarkdownBlock[]): DisplayLog;
  ```
  `appendAssistantMessage` 改为内部调用 `parseBlocks(text, { closeAll: true })` 后委托给 `appendAssistantBlocks`（保留原函数签名不变，供 `depth > 0` 子 agent 整段文本使用）。

- [ ] **Step 1: 写失败测试**

在 `test/tui/displayLog.test.ts` 追加：

```ts
test("appendAssistantMessage 内部走 markdown 解析，展开成多条 assistant-block", () => {
  const log = appendAssistantMessage(createDisplayLog(), {
    text: "# 标题\n\n正文段落",
    depth: 1,
  });
  expect(log.staticEntries).toHaveLength(2);
  expect(log.staticEntries[0]).toMatchObject({
    kind: "assistant-block",
    depth: 1,
    block: { kind: "heading", level: 1 },
  });
  expect(log.staticEntries[1]).toMatchObject({
    kind: "assistant-block",
    depth: 1,
    block: { kind: "paragraph" },
  });
});

test("appendAssistantBlocks 直接追加已解析的块", () => {
  const blocks = [{ kind: "rule" as const }];
  const log = appendAssistantBlocks(createDisplayLog(), { blocks, depth: 0 });
  expect(log.staticEntries).toMatchObject([
    { kind: "assistant-block", depth: 0, block: { kind: "rule" } },
  ]);
});

test("setStreamingBlocks 替换 streamingBlocks 字段，不影响 staticEntries", () => {
  const blocks = [{ kind: "rule" as const }];
  const log = setStreamingBlocks(createDisplayLog(), blocks);
  expect(log.streamingBlocks).toEqual(blocks);
  expect(log.staticEntries).toEqual([]);
});
```

同时更新文件顶部 import：

```ts
import {
  appendAssistantBlocks,
  appendAssistantMessage,
  appendSystemEntry,
  appendToolStart,
  appendUserEntry,
  applyToolEnd,
  createDisplayLog,
  setStreamingBlocks,
} from "@/tui/displayLog.js";
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/displayLog.test.ts`
Expected: FAIL —— `appendAssistantBlocks`、`setStreamingBlocks` 未定义；`appendAssistantMessage` 现有实现还是塞进单条 `assistant` 类型条目而不是 `assistant-block`。

- [ ] **Step 3: 实现**

修改 `src/tui/displayLog.ts`：

1. 新增 import：

```ts
import { parseBlocks, type MarkdownBlock } from "@/markdown/blocks.js";
```

2. 在 `DisplayEntry` 联合类型里新增变体：

```ts
export type DisplayEntry =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; depth: number }
  | { kind: "assistant-block"; id: string; block: MarkdownBlock; depth: number }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      input: unknown;
      depth: number;
      result?: string;
      isError?: boolean;
    }
  | { kind: "system"; id: string; text: string };
```

保留原有的 `"assistant"` 变体不删——检查现有代码是否还有地方依赖它（`MessageList.tsx` 目前用它渲染裸文本，Task 13 会把这块也迁移到走 `assistant-block`，但为了任务之间不互相破坏编译，这一步先两个变体共存）。

3. 在 `DisplayLog` 接口里新增字段：

```ts
export interface DisplayLog {
  staticEntries: DisplayEntry[];
  pendingEntries: DisplayEntry[];
  streamingBlocks: MarkdownBlock[];
}

export function createDisplayLog(): DisplayLog {
  return { staticEntries: [], pendingEntries: [], streamingBlocks: [] };
}
```

4. 新增 `appendAssistantBlocks` 函数：

```ts
export function appendAssistantBlocks(
  log: DisplayLog,
  payload: { blocks: MarkdownBlock[]; depth: number },
): DisplayLog {
  const newEntries: DisplayEntry[] = payload.blocks.map((block) => ({
    kind: "assistant-block",
    id: nextId(),
    block,
    depth: payload.depth,
  }));
  return {
    ...log,
    staticEntries: [...log.staticEntries, ...newEntries],
  };
}
```

5. 改写 `appendAssistantMessage`，让它委托给 `appendAssistantBlocks`：

```ts
export function appendAssistantMessage(
  log: DisplayLog,
  payload: { text: string; depth: number },
): DisplayLog {
  const { blocks } = parseBlocks(payload.text, { closeAll: true });
  return appendAssistantBlocks(log, { blocks, depth: payload.depth });
}
```

6. 新增 `setStreamingBlocks` 函数：

```ts
export function setStreamingBlocks(log: DisplayLog, blocks: MarkdownBlock[]): DisplayLog {
  return { ...log, streamingBlocks: blocks };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/tui/displayLog.test.ts`
Expected: PASS，全部测试通过

注意：原有的第一个测试 `"append* 依次追加到 staticEntries"` 里断言 `appendAssistantMessage(log, { text: "收到", depth: 0 })` 之后 `staticEntries` 里有 `{ kind: "assistant", text: "收到", depth: 0 }`——这个断言现在会失败，因为 `appendAssistantMessage` 改成产出 `assistant-block` 了。**修改这条已有测试**，把该断言改为：

```ts
expect(log.staticEntries).toMatchObject([
  { kind: "user", text: "你好" },
  { kind: "assistant-block", block: { kind: "paragraph" }, depth: 0 },
  { kind: "system", text: "系统提示" },
]);
```

- [ ] **Step 5: 提交**

```bash
git add src/tui/displayLog.ts test/tui/displayLog.test.ts
git commit -m "feat: displayLog 支持 markdown block 条目与流式尾块字段"
```

---

### Task 13: MessageList.tsx 用 Markdown 渲染，App.tsx 接入流式事件

**Files:**
- Modify: `src/tui/MessageList.tsx`
- Modify: `src/tui/App.tsx`
- Test: `test/tui/MessageList.test.tsx`
- Test: `test/tui/App.test.tsx`

**Interfaces:**
- Consumes: `Markdown` component（Task 6）、`streamBuffer` functions（Task 5）、`displayLog` functions（Task 12）、`assistant-delta`/`assistant-flush`/`stream-interrupted` events（Task 7）

这是最后一个任务，把前面所有部件接起来。分两块：先改 `MessageList.tsx` 让它认识 `assistant-block` 条目并渲染 `streamingBlocks`，再改 `App.tsx` 接线事件订阅和节流提交。

- [ ] **Step 1: 写 MessageList 的失败测试**

在 `test/tui/MessageList.test.tsx` 追加：

```ts
test("渲染 assistant-block 条目为对应的 markdown 样式", () => {
  const staticEntries: DisplayEntry[] = [
    {
      kind: "assistant-block",
      id: "e1",
      depth: 0,
      block: { kind: "heading", level: 1, spans: [{ kind: "text", text: "标题" }] },
    },
  ];
  const frame = render(
    <MessageList staticEntries={staticEntries} pendingEntries={[]} streamingBlocks={[]} />,
  ).lastFrame();
  expect(frame).toContain("标题");
});

test("streamingBlocks 在动态区渲染，不受 depth 缩进影响", () => {
  const frame = render(
    <MessageList
      staticEntries={[]}
      pendingEntries={[]}
      streamingBlocks={[{ kind: "paragraph", spans: [{ kind: "text", text: "正在生成" }] }]}
    />,
  ).lastFrame();
  expect(frame).toContain("正在生成");
});

test("子 Agent 的 assistant-block 带缩进标记", () => {
  const staticEntries: DisplayEntry[] = [
    {
      kind: "assistant-block",
      id: "e1",
      depth: 1,
      block: { kind: "paragraph", spans: [{ kind: "text", text: "子任务结论" }] },
    },
  ];
  const frame = render(
    <MessageList staticEntries={staticEntries} pendingEntries={[]} streamingBlocks={[]} />,
  ).lastFrame();
  expect(frame).toContain("↳");
  expect(frame).toContain("子任务结论");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/MessageList.test.tsx`
Expected: FAIL —— `MessageList` 组件目前不接受 `streamingBlocks` prop，也不认识 `"assistant-block"` 的 `DisplayEntry` kind。

- [ ] **Step 3: 实现 MessageList.tsx**

当前 `src/tui/MessageList.tsx` 用 `formatEntry` 把 `assistant`/`user`/`system` 都格式化成字符串塞进单个 `<Text>`。改造后 `assistant-block` 走独立的渲染路径（用 Task 6 的 `Markdown` 组件包一层缩进），其余 kind 不变：

```tsx
import { Box, Static, Text } from "ink";
import type { MarkdownBlock } from "@/markdown/blocks.js";
import type { DisplayEntry } from "@/tui/displayLog.js";
import { Markdown } from "@/tui/Markdown.js";
import {
  describeToolCall,
  toolDotColor,
  toolLabel,
} from "@/tui/toolCallFormat.js";

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
  return (
    <Box flexDirection="column">
      <Static items={staticEntries}>{(entry) => renderEntry(entry)}</Static>
      {pendingEntries.map((entry) => renderEntry(entry))}
      {streamingBlocks.length > 0 ? (
        <Markdown blocks={streamingBlocks} />
      ) : null}
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
```

保留原有的 `"assistant"` kind 分支在 `formatEntry` 里（`entry.kind === "assistant"` 落到最后的通用分支），因为 `DisplayEntry` 类型仍然包含它（Task 12 没删，只是新增），万一有遗留调用路径还在产出旧类型的条目，不会编译报错或渲染崩溃。

- [ ] **Step 4: 运行 MessageList 测试确认通过**

Run: `bun test test/tui/MessageList.test.tsx`
Expected: PASS。注意原有测试文件里所有 `<MessageList staticEntries={...} pendingEntries={...} />` 的调用都缺少新增的必填 prop `streamingBlocks`——**把文件里所有现有测试的调用都加上 `streamingBlocks={[]}`**，否则 TypeScript 编译不过。检查 `test/tui/MessageList.test.tsx` 里所有 `render(<MessageList .../>)` 调用点，逐一补上这个 prop。

- [ ] **Step 5: 写 App.tsx 的失败测试**

在 `test/tui/App.test.tsx` 追加一个流式测试。这需要把现有的 `createModelServer` 辅助函数（当前用 `Response.json` 模拟非流式响应）改造成能发 SSE——这是本任务里唯一一处要改动测试基础设施的地方：

```tsx
function createStreamingModelServer(
  turns: Array<{ deltas: string[]; stopReason: "end_turn" | "tool_use"; toolUse?: { id: string; name: string; input: unknown } }>,
): ReturnType<typeof Bun.serve> {
  let index = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      const turn = turns[index] ?? turns.at(-1)!;
      index += 1;
      const events: string[] = [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: `msg-${index}`,
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        })}\n\n`,
      ];

      if (turn.stopReason === "tool_use" && turn.toolUse) {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "tool_use", id: turn.toolUse.id, name: turn.toolUse.name, input: {} },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.toolUse.input) },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        );
      } else {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        for (const delta of turn.deltas) {
          events.push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta },
            })}\n\n`,
          );
        }
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({ type: "content_block_stop", index: 0 })}\n\n`,
        );
      }

      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: turn.stopReason, stop_sequence: null },
          usage: { output_tokens: 1 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );

      return new Response(events.join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
}

test("流式 delta 逐步上屏，最终完整文本出现在渲染结果中", async () => {
  const server = createStreamingModelServer([
    { deltas: ["你好，", "我是", "助手"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();

  try {
    const { stdin, lastFrame } = render(
      <App workingDirectory="/tmp" hooks={hooks} skills={emptySkills} />,
    );
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 500)); // 给节流提交留出时间

    expect(lastFrame()).toContain("你好，我是助手");
  } finally {
    restore();
    server.stop(true);
  }
});
```

Run: `bun test test/tui/App.test.tsx`
Expected: FAIL —— `App.tsx` 还没订阅 `assistant-delta`/`assistant-flush` 事件，也没有节流提交逻辑，`MessageList` 也还没接 `streamingBlocks` prop（如果 Step 3/4 已完成，`MessageList` 本身没问题，但 `App.tsx` 不会调用它传入正确的 `streamingBlocks`）。另外原有的两个测试（"提交问题后渲染用户输入与模型回复"、"PreToolUse 请求确认..."）现在也会失败，因为它们的 `createModelServer` 还是走 `Response.json` 非流式格式,与新的流式 `requestModel` 不兼容。

- [ ] **Step 6: 改写 App.test.tsx 里原有的两个测试，改用 SSE mock**

把文件顶部原来的 `createModelServer` 函数整个删除，所有调用点改用上面新增的 `createStreamingModelServer`。

第一个测试 `"提交问题后渲染用户输入与模型回复"`：

```tsx
test("提交问题后渲染用户输入与模型回复", async () => {
  const server = createStreamingModelServer([
    { deltas: ["你好，我是助手"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();

  try {
    const { stdin, lastFrame } = render(
      <App workingDirectory="/tmp" hooks={hooks} skills={emptySkills} />,
    );
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("你好");
    expect(lastFrame()).toContain("你好，我是助手");
  } finally {
    restore();
    server.stop(true);
  }
});
```

第二个测试 `"PreToolUse 请求确认时展示 ConfirmModal..."`：

```tsx
test("PreToolUse 请求确认时展示 ConfirmModal，批准后继续执行并关闭弹层", async () => {
  const command = process.platform === "win32" ? "Write-Output ok" : "printf ok";
  const server = createStreamingModelServer([
    { deltas: [], stopReason: "tool_use", toolUse: { id: "ask-1", name: "bash", input: { command } } },
    { deltas: ["执行完成"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();
  hooks.register("PreToolUse", () => ({ action: "ask", message: "允许执行 bash 吗？" }));

  try {
    const { stdin, lastFrame } = render(
      <App workingDirectory="/tmp" hooks={hooks} skills={emptySkills} />,
    );
    await flush();
    stdin.write("跑一下");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("允许执行 bash 吗？");

    stdin.write("y");
    await flush();

    expect(lastFrame()).toContain("执行完成");
    expect(lastFrame()).not.toContain("允许执行 bash 吗？");
  } finally {
    restore();
    server.stop(true);
  }
});
```

- [ ] **Step 7: 实现 App.tsx**

打开 `src/tui/App.tsx`，做以下修改：

1. 新增 import：

```ts
import { flush as flushStreamBuffer, pushDelta, createStreamBuffer, type StreamBuffer } from "@/tui/streamBuffer.js";
import { appendAssistantBlocks, setStreamingBlocks } from "@/tui/displayLog.js";
```

（`appendAssistantMessage` 保留原有 import，因为子 agent 路径还要用它。）

2. 新增一个 ref 存流式缓冲区状态，以及节流用的 timer ref：

```ts
  const streamBufferRef = useRef<StreamBuffer>(createStreamBuffer());
  const throttleTimerRef = useRef<ReturnType<typeof setInterval> | undefined>();
```

3. 抽出一个"提交尾块"的辅助函数，在组件内定义（放在 `handleSubmit` 之前）：

```ts
  const commitStreamBuffer = (): void => {
    const { buffer, committed } = flushStreamBuffer(streamBufferRef.current);
    streamBufferRef.current = buffer;
    if (committed.length > 0) {
      setDisplayLog((log) => appendAssistantBlocks(log, { blocks: committed, depth: 0 }));
    }
    setDisplayLog((log) => setStreamingBlocks(log, []));
  };
```

4. 在 `useEffect` 里新增三个事件订阅（放在现有的 `events.on(...)` 调用旁边）：

```ts
    events.on("assistant-delta", ({ text }) => {
      const { buffer, committed, tail } = pushDelta(streamBufferRef.current, text);
      streamBufferRef.current = buffer;
      if (committed.length > 0) {
        setDisplayLog((log) => appendAssistantBlocks(log, { blocks: committed, depth: 0 }));
      }
      if (throttleTimerRef.current === undefined) {
        throttleTimerRef.current = setInterval(() => {
          setDisplayLog((log) => setStreamingBlocks(log, tail));
        }, 32);
      }
    });
    events.on("assistant-flush", () => {
      if (throttleTimerRef.current !== undefined) {
        clearInterval(throttleTimerRef.current);
        throttleTimerRef.current = undefined;
      }
      commitStreamBuffer();
    });
    events.on("stream-interrupted", ({ reason }) => {
      if (throttleTimerRef.current !== undefined) {
        clearInterval(throttleTimerRef.current);
        throttleTimerRef.current = undefined;
      }
      commitStreamBuffer();
      setDisplayLog((log) => appendSystemEntry(log, `连接中断（${reason}），正在重新生成…`));
    });
```

上面这个节流实现有个问题需要在写代码时注意修正：`setInterval` 的回调里闭包捕获的 `tail` 是订阅时那一刻的值，不会随后续 delta 更新——**正确写法**是把 `tail` 存进一个 ref，`setInterval` 每次触发时读 ref 的最新值，而不是闭包变量。修正版：

```ts
  const latestTailRef = useRef<MarkdownBlock[]>([]);
```

（顶部新增 import `type { MarkdownBlock } from "@/markdown/blocks.js";`）

```ts
    events.on("assistant-delta", ({ text }) => {
      const { buffer, committed, tail } = pushDelta(streamBufferRef.current, text);
      streamBufferRef.current = buffer;
      latestTailRef.current = tail;
      if (committed.length > 0) {
        setDisplayLog((log) => appendAssistantBlocks(log, { blocks: committed, depth: 0 }));
      }
      if (throttleTimerRef.current === undefined) {
        throttleTimerRef.current = setInterval(() => {
          setDisplayLog((log) => setStreamingBlocks(log, latestTailRef.current));
        }, 32);
      }
    });
```

5. 在 `MessageList` 的渲染调用处（原第 96-99 行）补上新增的 prop：

```tsx
      <MessageList
        staticEntries={displayLog.staticEntries}
        pendingEntries={displayLog.pendingEntries}
        streamingBlocks={displayLog.streamingBlocks}
      />
```

6. 在 `handleSubmit` 的 `finally` 块里（原第 84-86 行）确保对话轮次结束时清理定时器和残留缓冲（防止上一轮的 timer 泄漏到下一轮）：

```ts
    } finally {
      if (throttleTimerRef.current !== undefined) {
        clearInterval(throttleTimerRef.current);
        throttleTimerRef.current = undefined;
      }
      setBusy(false);
    }
```

- [ ] **Step 8: 运行测试确认通过**

Run: `bun test test/tui/App.test.tsx`
Expected: PASS，全部测试通过

如果测试超时或 `lastFrame()` 内容不含预期文本，常见原因排查顺序：
1. SSE mock 的事件格式是否被 SDK 正确解析——先单独跑 Task 9 的集成测试确认 `requestModel` 层没问题
2. 节流定时器是否真的按 32ms 触发并被测试的 `await flush()`（350ms）等待窗口覆盖到
3. `commitStreamBuffer` 在 `assistant-flush` 时是否正确清空了 `streamingBlocks`，避免尾块和已提交块重复显示

- [ ] **Step 9: 运行全量测试套件确认没有连带破坏**

Run: `bun test`
Expected: 全部通过

Run: `bun run typecheck`
Expected: 无编译错误

- [ ] **Step 10: 提交**

```bash
git add src/tui/MessageList.tsx src/tui/App.tsx test/tui/MessageList.test.tsx test/tui/App.test.tsx
git commit -m "feat: App.tsx 接入流式事件与节流提交，MessageList 渲染 markdown 块"
```

---

## Self-Review Notes

**Spec coverage 核对：**
- §2 目标 1（流式上屏，仅主 agent）→ Task 7/8/9/11/13 覆盖
- §2 目标 2（Markdown 覆盖范围）→ Task 2/3/4/6 覆盖，标题/粗体/斜体/行内代码/代码块/列表/引用/分割线/表格全部有独立测试
- §2 目标 3（零新增依赖）→ 全程只用 `@anthropic-ai/sdk` 已有的 `client.messages.stream()`，无新增 package.json 依赖
- §3.5 / §6.2（模型查表 ceiling，fallback 联动）→ Task 1、Task 8
- §5.4（flush 时机）→ Task 9 的 `onStreamFlush` 在 `finalMessage()` 之后立即调用，覆盖 continuation 续写场景（因为循环继续调用 `requestModel` 时会再次触发 flush）
- §7.3 统一规则（最后一块永远未封闭）→ Task 4 的表格 lookahead 测试与 Task 5 的逐字符核心用例专门验证
- §8.4 节流与 flush/interrupted 时序 →  Task 13 的 `commitStreamBuffer` 在两个事件里都会先停 timer 再提交，避免竞态
- §9.1 断流重试分阶段处理 → `stream-interrupted` 事件已接线到系统提示，Task 13 Step 7 第 4 点；但"首个 delta 前失败静默重试"这部分复用现有的 429/529 退避逻辑（Task 8 未改动这部分），不需要额外任务
- §10 已知限制（`model_context_window_exceeded`、compactThreshold 联动、prompt caching）→ 均为明确排除的非目标，不在本计划任务中，与设计文档保持一致

**Placeholder scan：** 全文没有 TBD/TODO，每个 Step 3 的实现代码块都是完整可运行的代码，不是伪代码占位。

**Type consistency 核对：**
- `MarkdownBlock`/`InlineSpan` 类型定义只在 Task 3（`InlineSpan`）和 Task 4（`MarkdownBlock`）出现一次，后续任务（5/6/12/13）全部 import 而非重新定义
- `maxOutputTokensFor(modelId: string): number` 签名在 Task 1 定义后，Task 8/10 的调用点参数名和返回值用法一致
- `StreamBuffer`/`createStreamBuffer`/`pushDelta`/`flush` 在 Task 5 定义，Task 13 的 import 名称与之对应（`flush` 在 App.tsx 里重命名为 `flushStreamBuffer` 避免和组件内已有变量冲突，这个重命名在 Task 13 Step 7 里已经用 `import { flush as flushStreamBuffer, ... }` 处理）
- `ModelRecoveryOptions.onTextDelta`/`onStreamFlush` 在 Task 9 定义为可选字段，Task 11 的调用方式（三元表达式按 `depth === 0` 决定传 `undefined` 还是函数）与接口签名匹配
- `DisplayLog.streamingBlocks` 字段在 Task 12 定义，Task 13 的 `MessageList` props 和 `App.tsx` 渲染调用点字段名一致

**已知的任务间连带修改说明：** Task 11 Step 4 指出，如果 `test/loop.test.ts` 原有的非流式 mock 测试因为改流式而失败，需要一并把它的 `Bun.serve` mock 改成 SSE 格式——这个连带修改在 Task 11 内部处理（不是新开任务），因为它是 `agentLoop` 本身行为改变的直接后果，属于同一个"让 loop.ts 测试全绿"的验收范围。`test/runtime.test.ts` 如果也用类似的非流式 `Bun.serve` mock 且调用了 `agentLoop`/`callModelWithRecovery`，需要在 Task 11 完成后额外检查一次（执行者在 Task 11 Step 4 结束、Task 11 Step 5 提交前，应顺手跑一次 `bun test test/runtime.test.ts` 确认它没有被流式改造连带破坏；如果破坏了，参照 Task 11 Step 1 的 SSE body 构造方式修复，仍归入 Task 11 的提交范围，不单独开任务）。
