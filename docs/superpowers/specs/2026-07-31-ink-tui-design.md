# Ink TUI 改造设计

日期：2026-07-31
状态：已批准（待转入实现计划）

## 背景

当前 `mini-coding-agent` 的交互入口（[src/cli/main.ts](../../../src/cli/main.ts)）是一个基于 `node:readline` 的纯文本循环：每一轮用户输入触发 `agentLoop` 后，程序会同步阻塞直到整轮（可能包含多次模型调用与工具调用）结束，再一次性打印最后一条 assistant 文本。用户在整轮执行期间看不到任何中间过程（工具调用中/权限确认/ todo 状态变化）。

本设计把交互层换成基于 [Ink](https://github.com/vadimdemedes/ink)（React 渲染到终端）的 TUI，核心目标是把 `agentLoop` 执行过程中已经存在的离散事件（工具调用开始/结束、assistant 文本产出、todo 状态变化、权限确认请求）实时展示出来，而不是等整轮结束才看到结果。

## 目标

1. 消息历史滚动区 + 底部多行输入框（TUI 基本盘）。
2. 底部状态栏：当前工作目录、模型名、本轮 step 计数、执行中的 spinner。
3. Todo 面板：`todo_write` 工具调用后实时展示任务清单状态变化。
4. 交互式权限确认弹层：替换现在 `readline.question` 的 y/N 文本提示。
5. 工具调用过程实时可见（开始执行 / 执行完成 + 结果），无需等整轮结束。

## 非目标（本次不做）

- **模型文本流式输出**：`core/llm.ts` 的 `callModel` 仍然是一次性 `messages.create`，不改造成 `messages.stream`。也就是说 assistant 的文字依然是"整段一次性出现"，不会有逐字吐出的效果。这是后续可以独立做的升级，不在本次范围内。
- **子 Agent（Task 工具）输出折叠/收起**：子 Agent 产生的事件带有 `depth` 字段，本次只用它做简单的缩进前缀，不做可折叠的分组 UI。
- **非交互式（非 TTY）兜底路径**：程序检测到非 TTY 环境时直接报错退出（`process.exit(1)`），不保留/新增 readline 降级模式。

## 整体架构

```
src/
  core/
    events.ts        # 新增：AgentEvents 类型化事件发射器
    loop.ts           # 修改：新增可选 events 参数与几处 emit 调用
  tools/
    task.ts           # 修改：SubagentOptions 新增可选 events 字段（透传）
  tui/                 # 新增目录：全部 Ink 相关代码
    App.tsx
    MessageList.tsx
    StatusBar.tsx
    TodoPanel.tsx
    ConfirmModal.tsx
    InputBox.tsx
    confirmBridge.ts
    displayLog.ts      # DisplayEntry 类型定义
  cli/
    main.ts            # 修改：TTY 检测 + 挂载 Ink App
    render.ts           # 删除：职责被 MessageList 取代，无引用后是死代码
```

设计原则：`src/tui/` 只从 core 引入必要的类型（`AgentEvents`、`Todo`）和 `agentLoop`/`createState` 等既有入口函数，不反向渗透到 core 内部实现；core 侧的改动仅限于新增**可选**字段和插入几行 `emit` 调用，不改变任何已有函数签名的必选部分、不改变现有控制流。`HookBus` 保持只做权限策略决策（PreToolUse/PostToolUse/Stop/UserPromptSubmit），UI 通知完全走新的 `AgentEvents`，两条总线职责不混。

## 事件契约（src/core/events.ts）

```ts
export interface AgentEventMap {
  "step-start": { step: number; depth: number };
  "assistant-message": { text: string; depth: number };
  "tool-start": { id: string; toolName: string; input: unknown; depth: number };
  "tool-end": { id: string; toolName: string; result: string; isError: boolean; depth: number };
  "todo-changed": { todos: Todo[]; depth: number };
}

export interface AgentEvents {
  on<K extends keyof AgentEventMap>(event: K, fn: (payload: AgentEventMap[K]) => void): void;
  emit<K extends keyof AgentEventMap>(event: K, payload: AgentEventMap[K]): void;
}

export function createAgentEvents(): AgentEvents;
```

`depth` 取自 `state.depth`，天然区分主 Agent（depth 0）和 `task` 工具产生的子 Agent（depth ≥ 1）事件。

`loop.ts` 插入点：
- 循环顶部（`state.steps += 1` 之后）：`events?.emit("step-start", { step: state.steps, depth: state.depth })`。
- 模型响应 push 进 `state.messages` 之后：把 `response.content` 里 `type === "text"` 的块拼接成一段文本，`events?.emit("assistant-message", { text, depth: state.depth })`（若拼接结果为空字符串则不 emit）。
- 每个 `toolUse` 进入处理循环最前（即触发 `PreToolUse` 之前）：`events?.emit("tool-start", { id: toolUse.id, toolName: toolUse.name, input: toolUse.input, depth: state.depth })`。
- `tool-end` 与 `tool-start` 按 `id` 严格一一配对：不管最终走的是 `PreToolUse` 返回 `block`、返回 `ask` 但用户拒绝、`dispatch` 成功、还是 `dispatch` 抛异常，这四个分支各自对应的 `results.push(...)` 位置都要 emit 恰好一次 `tool-end`（`isError` 分别对应 `true`/`true`/`false`/`true`）。这样 UI 侧根据 `id` 更新已存在的展示条目时，永远能找到对应的 `tool-start`，不需要处理"没有 start 的 tool-end"这种孤儿情况。
- 当 `toolUse.name === "todo_write"` 且本次工具调用走到了 `dispatch` 成功分支（未被 `PreToolUse` 拦截）时：额外 `events?.emit("todo-changed", { todos: state.todos, depth: state.depth })`。

`AgentLoopOptions` 新增可选字段 `events?: AgentEvents`。`tools/task.ts` 的 `SubagentOptions` 同步新增 `events?: AgentEvents`，因为 `spawnSubagent` 内部已经用 `{ ...options, skills }` 透传 options 给递归的 `agentLoop` 调用，加上字段声明后无需改动调用点即可自动生效。

## TUI 组件设计（均位于 src/tui/）

- **App.tsx**：顶层状态容器。职责：
  - 创建 `state = createState()`、`events = createAgentEvents()`、`confirmBridge`。
  - 持有 React state：`displayLog: DisplayEntry[]`、`todos: Todo[]`、`busy: boolean`、`step: number`、`pendingConfirm: ConfirmRequest | undefined`。
  - 挂载时 `events.on(...)` 一次性注册所有事件类型的处理器，把事件映射成 `displayLog`/`todos`/`step` 的更新；同时 `confirmBridge.subscribe((request) => setPendingConfirm(request))` 注册一次。
  - `onSubmit(text)`：push 用户消息到 `state.messages`，追加 `user` 展示条目，设 `busy = true`，调用 `agentLoop(state, { hooks, skills, confirm: confirmBridge.confirm, events })`；`finally` 里设 `busy = false`；`catch` 里把错误信息追加为 `system` 展示条目（包括 `MaxStepsExceededError`）。
- **MessageList.tsx**：渲染 `displayLog`，`depth > 0` 的条目加前缀缩进（如 `"  ↳ "` 重复 depth 次）。为避免长会话下渲染开销无限增长，`displayLog` 只保留最近 500 条，超出时从头部丢弃（这是简单的内存/渲染安全阀，不是滚动视口功能；丢弃的条目不再可见，属于已知取舍）。
- **StatusBar.tsx**：接收 `{ cwd, model, step, busy }` props，渲染一行状态文本；`busy` 为真时显示 spinner（`ink-spinner`）。
- **TodoPanel.tsx**：接收 `{ todos }`，为空数组时不渲染任何内容。
- **ConfirmModal.tsx**：接收 `{ request: ConfirmRequest }`，`useInput` 监听 `y`/`n`（以及方向键 + Enter）触发 `request.respond(boolean)`，随后由 `App` 清空 `pendingConfirm`。
- **InputBox.tsx**：基于 `ink-text-input` 的受控输入框，`disabled = busy || pendingConfirm !== undefined` 时不接收输入（渲染为置灰提示而不是隐藏，避免用户以为程序卡死）。
- **confirmBridge.ts**：`confirm` 与"通知 App 显示弹层"通过一次性 `subscribe` 回调解耦，`App` 挂载时只订阅一次：
  ```ts
  export interface ConfirmRequest {
    message: string;
    respond: (value: boolean) => void;
  }

  export interface ConfirmBridge {
    confirm: (message: string) => Promise<boolean>; // 传给 agentLoop 的 options.confirm
    subscribe: (handler: (request: ConfirmRequest) => void) => void; // App 挂载时调用一次
  }

  export function createConfirmBridge(): ConfirmBridge {
    let handler: ((request: ConfirmRequest) => void) | undefined;
    return {
      subscribe: (fn) => { handler = fn; },
      confirm: (message) =>
        new Promise<boolean>((resolve) => {
          handler?.({ message, respond: resolve });
        }),
    };
  }
  ```
  `App` 挂载时 `confirmBridge.subscribe((request) => setPendingConfirm(request))`；`ConfirmModal` 拿到 `pendingConfirm` 后，按键触发 `pendingConfirm.respond(true/false)` 再清空 `pendingConfirm`。
- **displayLog.ts**：定义 UI 专用的展示条目类型，不复用 Anthropic SDK 的 `MessageParam`：
  ```ts
  export type DisplayEntry =
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string; depth: number }
    | { kind: "tool"; id: string; toolName: string; input: unknown; result?: string; isError?: boolean; depth: number }
    | { kind: "system"; text: string };
  ```

## 数据流（一次完整交互）

1. 用户在 `InputBox` 回车 → `App.onSubmit`：push 到 `state.messages` + 追加 `user` 展示条目，`busy = true`。
2. 调用 `agentLoop(state, { hooks, skills, confirm: confirmBridge.confirm, events })`。
3. `loop.ts` 执行过程中触发的事件通过已注册的 `events.on(...)` 处理器同步更新 `displayLog`/`todos`/`step`，Ink 自动重渲染。
4. 若某次 `PreToolUse` 命中 `ask`：`agentLoop` 调用 `confirm(message)` → `confirmBridge` 让 `App` 显示 `ConfirmModal` → 用户按键 → resolve → `agentLoop` 继续 → 恢复正常输入框。
5. `agentLoop` 正常结束或抛出异常（包括 `MaxStepsExceededError`）：`busy = false`；异常统一被 `App.onSubmit` 的 `catch` 捕获，转成一条 `system` 展示条目，会话不退出、可以继续下一轮输入。

## 错误处理

- **非 TTY**：`main.ts` 检测 `process.stdin.isTTY && process.stdout.isTTY` 为假时，`console.error("需要交互式终端"); process.exit(1)`。
- **`MaxStepsExceededError`**：与现状语义一致，作为 `system` 展示条目提示，允许继续输入下一轮。
- **`agentLoop` 抛出的其它异常**（网络错误等）：现状是 `main()` 顶层 `catch` 直接让进程以非零码退出；TUI 模式下必须避免"一次网络报错就得重启整个会话"，因此改为在每轮的 `onSubmit` 里 catch 并展示为错误条目，进程保持存活。这是本次改造下必须补的行为变化（否则设计无法自洽），不是范围外的加料。
- **Ctrl+C**：沿用 Node 默认 SIGINT 行为直接退出，不做特殊拦截。

## 依赖与配置改动

- 新增运行时依赖：`ink`、`react`、`ink-text-input`、`ink-spinner`。
- 新增开发依赖：`@types/react`、`ink-testing-library`。
- `tsconfig.json` 增加 `"jsx": "react-jsx"`（`.tsx` 文件的类型检查和 `tsc` 构建都需要）。
- 删除 `src/cli/render.ts` 及其唯一引用（`main.ts` 里的 `renderLastAssistantMessage` 调用）。

## 测试计划

- `test/loop.test.ts` 追加用例：传入 `events`，用现有的 `Bun.serve` mock 模型服务器写法，断言工具调用/assistant 消息/`todo_write` 场景下事件按预期的顺序和内容触发。
- 新增 `test/tui/*.test.tsx`：用 `ink-testing-library` 做少量冒烟测试——`ConfirmModal` 按 `y`/`n` 能正确 resolve、`StatusBar`/`TodoPanel` 能根据 props 渲染出预期文本。不追求全量覆盖（UI 展示层的测试性价比有限）。
- 手动验证：`bun run dev` 在真实终端中跑一轮包含权限确认 + `todo_write` 的会话，肉眼确认状态栏/Todo 面板/确认弹层显示正常。

## 后续可能的演进方向（不在本次范围内）

- 模型响应改为流式（`messages.stream`），配合 `assistant-message` 事件增加增量 delta 类型，实现逐字吐出。
- 子 Agent 输出的可折叠分组展示。
- 非交互式/脚本化调用支持。
