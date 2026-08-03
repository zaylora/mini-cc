# TUI 流式输出与 Markdown 渲染

日期：2026-08-03

## 1. 背景

当前 TUI 有两个体验缺口：

- **无流式输出**。`src/core/llm.ts:139` 使用 `client.messages.create()` 一次性返回整包响应；`src/core/loop.ts:72-82` 拿到完整响应后才 `emit("assistant-message")`。长回复期间界面完全静止，用户无法判断是在生成还是卡死。
- **无 Markdown 渲染**。`src/tui/MessageList.tsx:48-56` 的 `formatEntry` 直接输出裸文本，`##`、`**`、围栏代码块的语法标记原样显示。

本设计解决这两点。

## 2. 范围

### 目标

1. assistant 文本流式上屏（`text_delta`），仅主 agent（`depth === 0`）
2. Markdown 渲染：标题 h1–h3、粗体、斜体、行内代码、围栏代码块、有序/无序列表、引用、分割线、GFM 表格
3. 零新增依赖（自研解析器）

### 非目标

| 项 | 原因 |
|---|---|
| 工具调用参数流式（`input_json_delta`） | 需处理残缺 JSON，复杂度不匹配收益 |
| thinking 流式 | 当前请求未启用 thinking 参数，需同步改请求配置 |
| 代码块语法高亮 | 需额外依赖，与项目极简依赖风格冲突 |
| 子 agent（`depth > 0`）流式 | 子 agent 输出主要供主 agent 消费，逐字上屏噪音大，且会与主流抢动态区 |
| ESC 中断生成 | 需 AbortController 贯穿 llm → loop → TUI，并处理半段 assistant 消息如何入历史，单独 spec |
| `model_context_window_exceeded` 处理 | 既有缺陷，与流式无关，见 §10 |

## 3. 关键事实与设计依据

以下 API 行为已核实（Anthropic 官方文档，2026-08-03），是后续设计决策的依据：

1. **OTPM 限流不按 `max_tokens` 预扣。** 官方原文：*"OTPM rate limits are evaluated in real time as output tokens are produced, counting only the actual tokens generated. The `max_tokens` parameter does not factor into OTPM rate limit calculations, so there is no rate limit downside to setting a higher `max_tokens` value."* 因此调高 `max_tokens` 没有限流代价。

2. **`input + max_tokens` 超上下文窗口不报错。** 在 Claude 4.5 及更新模型上，API 接受该请求；若生成过程真的触达窗口边界，才以 `stop_reason: "model_context_window_exceeded"` 停止。只有 **input 本身**超窗口才返回 400 `invalid_request_error`（`prompt is too long`）。

3. **非流式请求 `max_tokens` 超过约 16K 有 HTTP 超时风险。** 官方对所有模型的建议是超过该量级必须流式。现有 `MAX_TOKENS = 16_000`（`src/config.ts:3`）恰好压在这条线上，而升档后的 `ESCALATED_MAX_TOKENS = 64_000` 走的仍是非流式，本身处于超时风险区。

4. **窗口余量。** 默认模型 `claude-sonnet-5`（`src/config.ts:8`）为 1M 窗口 / 128K 最大输出。`compactThreshold = 150_000`（`src/context/manager.ts:44`）意味着 input 峰值约 150K，即使 `maxTokens` 吃满 128K ceiling（见 §3.5），合计 278K，相对 1M 窗口仍余量充足。

5. **单次输出上限（ceiling）与上下文窗口是两个独立轴，超限报错方式也不同。** 已核实：

   | 模型 | 上下文窗口 | 单次输出 ceiling |
   |---|---|---|
   | `claude-sonnet-5`（默认，`[1m]` 变体）、Opus 5/4.8/4.7/4.6、Fable 5、Mythos 5、Sonnet 4.6 | 1M | **128K** |
   | Sonnet 4.5、Haiku 4.5 等 200K 窗口模型 | 200K | **64K** |

   超**窗口**（§3.2）是接受请求、跑到边界才停，`stop_reason: "model_context_window_exceeded"`，软失败。超**输出 ceiling** 是**请求阶段直接 400** `invalid_request_error`，报错形如 `max_tokens: X > Y, which is the maximum allowed number of output tokens for <model>`，硬失败，一次都不会生成。

   这意味着 `MAX_TOKENS` 不能是全局写死的一个数：写 128K 在默认模型上刚好吃满，但 `src/core/loop.ts:70` 的 `FALLBACK_MODEL_ID` 或用户通过 `ANTHROPIC_MODEL`/`MODEL_ID` 指向的模型若 ceiling 只有 64K，每次请求都会在生成前被 400 拒绝。

## 4. 架构与模块边界

新增 5 个文件、修改 7 个文件，零新增依赖。分层原则：**纯函数解析 / React 只做渲染**。

### 新增

| 文件 | 职责 | 依赖 |
|---|---|---|
| `src/markdown/width.ts` | 终端显示宽度计算与截断 | 无 |
| `src/markdown/inline.ts` | 行内分词 | 无 |
| `src/markdown/blocks.ts` | 块级扫描，带封闭标记与源码偏移 | `inline` |
| `src/tui/Markdown.tsx` | `MarkdownBlock[]` → ink JSX | `blocks`、`width` |
| `src/tui/streamBuffer.ts` | 累积 delta，切分已封闭块与尾块 | `blocks` |
| `src/core/modelLimits.ts` | 模型 ID → 输出 ceiling 的查表函数 | 无 |

### 修改

| 文件 | 改动 |
|---|---|
| `src/core/events.ts` | 新增 3 个事件 |
| `src/core/llm.ts` | `requestModel` 改流式；新增 delta 回调；删除 max_tokens 升档分支；fallback 切换时按新模型重新钳制 `state.maxTokens` |
| `src/core/loop.ts` | 桥接 delta 到事件；原 `assistant-message` emit 加 `depth > 0` 条件；初始化 `state.maxTokens` 改为按模型查表 |
| `src/core/state.ts` | 删除 `hasEscalatedMaxTokens` 字段 |
| `src/config.ts` | 删除固定的 `MAX_TOKENS`，改为 `src/core/modelLimits.ts` 的查表函数 |
| `src/tui/displayLog.ts` | 新增 `assistant-block` 条目类型与 `streamingBlocks` 字段 |
| `src/tui/MessageList.tsx` | assistant 内容改用 `Markdown` 渲染 |
| `src/tui/App.tsx` | 订阅新事件；delta 节流 |

`src/markdown/` 完全不认识 ink 和 React，是可独立单测的纯数据变换；`streamBuffer` 不认识 React，只做「文本 → (已封闭块, 尾块)」；React 层不含任何解析逻辑。

## 5. 流式链路

### 5.1 llm.ts

只改 `requestModel` 的内部实现，`callModelWithRecovery` 的对外契约（返回完整 `Message`）**保持不变**。因此续写、reactive compact、429/529 退避、fallback 模型切换全部零改动。

```
client.messages.stream()  →  .on("text", delta)  →  onTextDelta 回调
                          →  await finalMessage()  →  返回 Message（与非流式同构）
```

`ModelRecoveryOptions` 新增两个可选回调：

```ts
onTextDelta?: (text: string) => void
onStreamEvent?: (event: "flush" | { interrupted: string }) => void
```

### 5.2 事件

`src/core/events.ts` 新增：

```ts
"assistant-delta":    { text: string; depth: number }   // 增量片段
"assistant-flush":    { depth: number }                 // 单次 stream 收尾，强制封闭尾块
"stream-interrupted": { reason: string; depth: number } // 已出 delta 后断流
```

现有 `assistant-message` 事件保留，专供 `depth > 0` 的子 agent 走整段路径。

### 5.3 loop.ts

- 仅在 `state.depth === 0` 时把 llm 的回调桥接到事件
- 现有的 `if (assistantText) emit("assistant-message")` 改为 `if (assistantText && state.depth > 0)` —— 否则主 agent 的文本会在流式之后再整段重复上屏一次

### 5.4 flush 时机

`llm.ts` 在**每次单个 stream 结束后**立即发 `assistant-flush`，不论接下来是 `return` 还是走 continuation 续写。这样续写产生的文本自然成为新块追加，既不重复也不错序。

## 6. max_tokens：去掉升档

### 6.1 升档原本做什么

`src/core/llm.ts:62-72` 撞 `max_tokens` 时是三级策略：

| 级 | 动作 | 目的 |
|---|---|---|
| 1 | `maxTokens = 64K` 后 `continue` **重发**（不 push 截断内容） | 扩容后**一次写完**长输出，无接缝 |
| 2 | push 截断内容 + `CONTINUATION_PROMPT`，最多 3 次 | 64K 也撞满，接受拼接续写 |
| 3 | `return response` | 放弃，交回截断结果 |

关键点：**抬高闸刀只在「重发」这一步有意义**。走 continuation 拼接时每段 16K 就够，拼几段都行；`ESCALATED_MAX_TOKENS = 64_000` 存在的唯一目的是让模型有机会在一次响应里一气呵成写完，代价是丢弃第一次那 16K（重复生成、重复计费）。

一句话：**升档 = 用一次重发的浪费，换一份没有接缝的输出。**

`MAX_TOKENS` 默认取 16K 的唯一站得住的理由是 §3.3 的非流式超时线。

### 6.2 决策

**流式下删除升档，`maxTokens` 改为按模型动态取输出 ceiling（§3.5），不再是写死的常量。**

依据：

- 16K 那条非流式超时线在流式下不再成立（§3.3）
- 调高 `max_tokens` 无限流代价（§3.1）
- 保留升档就必然在流式下重复上屏（前 16K 内容出现两遍），这是用户每次都会看到的确定性伤害
- 写死一个数（无论 16K 还是 64K）在 1M 窗口模型上都是浪费——`claude-sonnet-5` 的 ceiling 是 128K，§3.5 已核实。但直接写死 128K 又会在 64K-ceiling 模型上导致每次请求 400，所以必须按模型查表，而不是选一个折中的固定值

新增 `src/core/modelLimits.ts`：

```ts
export function maxOutputTokensFor(modelId: string): number {
  return LOW_CEILING_MODELS.has(modelId) ? 64_000 : 128_000;
}
```

`LOW_CEILING_MODELS` 收录已知 200K 窗口模型（Sonnet 4.5、Haiku 4.5 等）；不在表中的模型 ID（包括未来新模型、自定义网关模型名）默认按 128K 处理，因为默认模型与主流新模型都是 1M/128K。这个默认值本身是判断调用：宁可对极少数未收录的 64K-ceiling 模型触发一次 400（会被现有 `isTransientError`/`isPromptTooLongError` 之外的分支直接抛出，用户能看到明确报错去调整），也不为了兼容它们而让主路径永久少用一半输出额度。

具体改动：

- 删除 `ESCALATED_MAX_TOKENS` 常量与 `state.hasEscalatedMaxTokens` 字段
- 删除 `src/core/llm.ts:63-67` 的升档分支，撞 `max_tokens` 直接落入 continuation 分支
- 删除 `src/config.ts:3` 的 `MAX_TOKENS` 常量
- `src/core/loop.ts:55`（原 `state.maxTokens = MAX_TOKENS`）改为 `state.maxTokens = maxOutputTokensFor(state.modelId)`
- fallback 切换处（`src/core/llm.ts:89-91`，`state.modelId = options.fallbackModelId` 那一行之后）补一行 `state.maxTokens = maxOutputTokensFor(state.modelId)`，否则从 128K-ceiling 模型切到 64K-ceiling 模型后，携带旧 `maxTokens` 的下一次请求会先被 400 拒绝
- 同步删除 `src/core/state.ts` 中对 `hasEscalatedMaxTokens` 字段的初始化

### 6.3 承担的代价

首次撞 `max_tokens` 不再重发换干净输出，改为在截断点拼接续写。截断可能落在半个代码块中间，接缝处存在语法瑕疵风险。

接受理由：`CONTINUATION_PROMPT`（"Pick up mid-thought"）本就是为这个场景写的，且原设计第 2 级已经接受了同样的风险 —— 新方案只是把它提前到第 1 级。

## 7. Markdown 解析器

### 7.1 width.ts

```ts
displayWidth(text: string): number        // CJK 全角计 2，组合记号计 0
truncateToWidth(text: string, max: number): string
```

按码点遍历，用 Unicode 区间表判断全角：CJK 统一汉字、CJK 扩展与兼容区、全角标点、全角 ASCII、平假名/片假名、韩文音节。组合记号区（U+0300–U+036F）宽度计 0。

### 7.2 inline.ts

```ts
type InlineSpan =
  | { kind: "text" | "bold" | "italic" | "code"; text: string }
  | { kind: "link"; text: string; href: string }

parseInline(source: string): InlineSpan[]
```

单遍扫描，优先级：`` `code` `` > `**bold**` > `*italic*` / `_italic_` > `[text](href)`。

**明确限制：不支持嵌套。** `**加粗里有 `代码`**` 渲染为整段加粗，反引号原样保留。这是避免递归下降的取舍 —— 文本不丢，只丢一层样式。未闭合标记按纯文本处理。

### 7.3 blocks.ts

```ts
type MarkdownBlock =
  | { kind: "heading"; level: 1 | 2 | 3; spans: InlineSpan[] }
  | { kind: "paragraph"; spans: InlineSpan[] }
  | { kind: "code"; lang?: string; lines: string[] }
  | { kind: "list"; ordered: boolean; items: { spans: InlineSpan[]; indent: number }[] }
  | { kind: "quote"; spans: InlineSpan[] }
  | { kind: "rule" }
  | {
      kind: "table"
      header: InlineSpan[][]
      align: ("left" | "center" | "right")[]
      rows: InlineSpan[][][]
    }

parseBlocks(source: string, opts?: { closeAll?: boolean }): {
  blocks: MarkdownBlock[]
  closed: boolean[]       // 与 blocks 一一对应
  endOffsets: number[]    // 每块在 source 中的结束位置，streamBuffer 用它切文本
}
```

封闭判定是块级提交的全部依据：

| 块 | 封闭条件 |
|---|---|
| heading / rule | 读到换行即封闭（单行块） |
| code | 读到收尾的三反引号 |
| paragraph / list / quote / table | 读到空行，或读到不属于本块的行 |

**统一规则：最后一个块永远视为未封闭**，除非它是单行块且已读到换行，或 `closeAll: true`（流结束时强制封闭全部）。

这条规则同时解决了表格的 lookahead 问题：`| a | b |` 单独一行无法判断是表格还是段落（要看下一行是否为 `|---|---|`），但它是最后一个块 → 未封闭 → 不会被提前提交。等分隔行到达再定性，不会出现「提交成段落后又需改成表格」的错误。

## 8. 块级提交与渲染

### 8.1 streamBuffer.ts

```ts
pushDelta(buffer, delta): { buffer, committed: MarkdownBlock[], tail: MarkdownBlock[] }
flush(buffer):            { buffer, committed: MarkdownBlock[] }
```

每次 delta：

1. `pending += delta`
2. `parseBlocks(pending)`
3. 取最后一个 `closed === true` 之前的所有块作为 `committed`
4. 用其 `endOffsets` 把对应源码从 `pending` 中切掉
5. 余下的块作为 `tail`

已封闭的块不再参与后续解析，因此每帧只重解析尾部，长回复不会退化。

### 8.2 Markdown.tsx

| 块 | 渲染 |
|---|---|
| heading | `<Text bold color="cyan">` |
| paragraph | `<Text>` + spans |
| code | 左缩进 2 空格 + `<Text color="cyan">`；首行 dim 显示语言标签。**不使用 `borderStyle`** —— 窄终端下容易折行错乱 |
| list | `• ` / `1. ` 前缀，按 `indent` 缩进 |
| quote | `<Text dimColor>│ ` 前缀 |
| rule | `─` 重复到终端宽度 |
| table | `width.ts` 算列宽 + `┌─┬─┐` 绘框，超终端宽度按列截断 |

span 渲染：`bold` → `<Text bold>`，`italic` → `<Text italic>`，`code` → `<Text color="yellow">`，`link` → `<Text underline color="blue">`。

终端宽度取 `useStdout().stdout.columns`，用于 `rule` 与 `table`。

### 8.3 displayLog.ts

新增 Static 条目类型：

```ts
| { kind: "assistant-block"; id: string; block: MarkdownBlock; depth: number }
```

`DisplayLog` 新增 `streamingBlocks: MarkdownBlock[]` 字段，存尾块，在动态区渲染。

现有 `appendAssistantMessage`（`depth > 0` 的子 agent 整段文本）改为内部调 `parseBlocks(text, { closeAll: true })` 后展开成多条 `assistant-block`。这样子 agent 输出也有 markdown，渲染路径只有一条。

### 8.4 App.tsx 节流

delta 每秒可达几十次，每次 `setState` 都会触发 ink 重绘。用 ref 累积、32ms（约 30fps）定时提交一次。

**硬约束：`assistant-flush` 与 `stream-interrupted` 到达时必须先强制提交待处理 delta 再处理事件**，否则尾块会丢字或错序。

## 9. 错误处理与恢复

### 9.1 断流重试

分阶段处理：

| 阶段 | 处理 |
|---|---|
| 首个 delta 到达**前**失败 | 静默重试，UI 无感（覆盖绝大多数情况，因为 429/529 通常发生在请求建立阶段） |
| 已有 delta 后断流 | 先发 `assistant-flush` 保住已生成内容，再发 `stream-interrupted`，TUI 插一行系统提示「连接中断，重新生成」，然后继续重试并追加新文本 |

### 9.2 continuation 续写

`llm.ts` 在每次单个 stream 结束后都发 `assistant-flush`（§5.4），所以续写文本作为新块追加，无重复、无错序。

### 9.3 其他错误

`prompt_too_long` → reactive compact、429/529 退避、fallback 模型切换均沿用现有逻辑，本设计不改。

## 10. 已知限制与后续工作

以下问题已识别但不在本次范围：

1. **`model_context_window_exceeded` 未处理。** `src/core/llm.ts:62` 只判断 `stop_reason !== "max_tokens"`，`model_context_window_exceeded` 会直接 return 并被当成正常完成，导致回复静默截断、无提示、无恢复。

   触发条件与模型窗口相关（§6.2 之后 `maxTokens` 按 §3.5 的表动态取值，但窗口本身不受影响）：

   | 模型 | 窗口 | `maxTokens`（按 §6.2 查表） | 150K input 后的输出空间 | 触发风险 |
   |---|---|---|---|---|
   | `claude-sonnet-5`（默认）、Opus 5/4.8/4.7/4.6、Sonnet 4.6、Fable 5 | 1M | 128K | 约 850K | 几乎不可能 |
   | Sonnet 4.5、Haiku 4.5、其余 | 200K | 64K | 约 50K | 会触发 |

   即：停在 1M 窗口模型上时窗口不是约束；一旦通过 `ANTHROPIC_MODEL` 换到 200K 窗口的模型，`compactThreshold = 150K` 会把输出空间挤到只剩约 50K，而该模型 `maxTokens` 查表得到的 64K 承诺的空间并不存在。

   流式会让这个缺陷更明显 —— 非流式是一次性给出一段截断文本，流式是文字流到一半突然停住。

2. **fallback 模型切换不调整 `compactThreshold`。** `state.maxTokens` 已在 §6.2 修复为随 fallback 切换重新查表，但 `compactThreshold`（`src/context/manager.ts:44`，固定 150_000）不认识 `state.modelId`。主模型 1M、备用 200K 的组合下，切换瞬间 input 可能已远超备用模型的 200K 窗口 → 400 `prompt is too long` → reactive compact 只允许一次（`hasAttemptedReactiveCompact`）→ 第二次直接抛错。让 `compactThreshold` 随模型窗口动态调整超出本次范围（涉及压缩策略本身的改动），留待后续处理。

3. **`contextTokens()` 与 prompt caching 不兼容。** `src/context/manager.ts:272` 使用 `state.lastInputTokens`（即 `response.usage.input_tokens`）判断是否压缩。官方文档明确：启用 prompt caching 后 `input_tokens` 只统计**最后一个 cache breakpoint 之后**的 token，总量应为 `cache_read_input_tokens + cache_creation_input_tokens + input_tokens`。当前代码未使用 caching，所以暂时正确；若后续引入 caching，压缩阈值会严重低估而永不触发。

4. **ESC 中断生成。** 见 §2 非目标。

## 11. 测试策略

沿用现有 bun test + ink-testing-library 模式，`src/markdown/` 三层是纯函数因此可穷举：

| 测试文件 | 覆盖 |
|---|---|
| `test/markdown/width.test.ts` | CJK 双宽、组合记号计 0、截断边界 |
| `test/markdown/inline.test.ts` | 各 span 类型、未闭合标记降级、嵌套降级 |
| `test/markdown/blocks.test.ts` | 各块类型、`closed` 标记、表格 lookahead、`endOffsets` 正确性 |
| `test/tui/streamBuffer.test.ts` | **核心用例**：逐字符喂入含代码块与表格的 markdown，断言任意中间状态下都不会把未封闭块提交进 Static |
| `test/tui/Markdown.test.tsx` | 各块渲染输出 |
| `test/tui/App.test.tsx` | 注入事件序列，断言块级提交与系统提示行 |
| `test/llm.test.ts` | 复用现有 `options.request` 注入点喂 fake stream，断言 delta 回调序列；`test/llm.test.ts:8` 那条「升档重试」改写为「首个 max_tokens 直接走 continuation」；新增用例断言 fallback 切换后 `state.maxTokens` 按新模型重新查表 |
| `test/core/modelLimits.test.ts` | 已知模型返回对应 ceiling，未收录模型 ID 默认按 128K 处理 |
