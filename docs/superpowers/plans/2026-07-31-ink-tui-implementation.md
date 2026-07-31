# Ink TUI 改造 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `mini-agent` CLI 的交互界面从 readline 换成基于 Ink 的 TUI，展示消息历史、状态栏、Todo 面板与交互式权限确认弹层，同时保持 `src/core`、`src/hooks`、`src/tools` 完全不感知 React/Ink。

**Architecture:** 新增一个独立的类型化事件总线 `AgentEvents`（`src/core/events.ts`），由 `agentLoop` 在关键节点 emit；所有 UI 代码集中在 `src/tui/`，通过订阅 `AgentEvents` 和一个 `ConfirmBridge`（解耦 `agentLoop` 现有的 `confirm` 回调）来渲染界面。`src/cli/main.ts` 只负责 TTY 检测与挂载 Ink 根组件。

**Tech Stack:** TypeScript + Bun test runner；Ink 5、React 18、ink-text-input、ink-spinner、ink-testing-library。

## Global Constraints

- Node 引擎下限保持 `>=18`（`package.json` 现有 `engines.node`），因此依赖必须锁定为：`ink@^5.2.1`、`react@^18.3.1`、`ink-text-input@^6.0.0`、`ink-spinner@^5.0.0`（dependencies）；`@types/react@^18.3.31`、`ink-testing-library@^4.0.0`（devDependencies）。均已通过 `npm view <pkg> peerDependencies engines` 验证互相兼容且满足 `node >= 18`。
- 不做模型层流式输出改造（`src/core/llm.ts` 的 `callModel` 保持非流式，不在本计划范围内）。
- 不做子 Agent 折叠/收起 UI，只用 `depth` 做缩进区分。
- 不支持非交互式/管道用法：非 TTY 时直接报错退出（`process.exitCode = 1`），不保留 readline 回退。
- `DisplayEntry` 日志上限精确为 500 条，超出时从头部丢弃（`src/tui/displayLog.ts` 的 `MAX_DISPLAY_ENTRIES`）。
- `tool-start`/`tool-end` 必须严格一一配对：`tool-start` 在每个 `toolUse` 处理最开头 emit（`PreToolUse` 触发之前）；`tool-end` 必须在 block / ask 拒绝 / dispatch 成功 / dispatch 抛错 这 4 个分支中各 emit 恰好一次。
- `src/core`、`src/hooks`、`src/tools` 中除 `src/core/loop.ts`（挂 `events` 选项）、`src/tools/task.ts`（透传 `events` 选项）、`src/tools/todo.ts`（导出已有的 `STATUS_MARKS` 常量）外，不做其他修改。
- 已知的、与本计划无关的预先存在问题：`test/builtins.test.ts:5` 引用了 `src/hooks/builtins.ts` 中不存在的导出 `createAutoGitAddHook`（该文件只有 `createAuditHook`/`createWorkingDirectoryHook`），导致 `bun run typecheck` 当前即会报错。本计划不修复它；执行任务时用 `bun test <具体文件>` / `bun run typecheck` 时如果看到这一条已知失败，忽略即可，不要误认为是自己引入的回归。

---

### Task 1: `AgentEvents` 事件总线

**Files:**
- Create: `src/core/events.ts`
- Test: `test/events.test.ts`

**Interfaces:**
- Produces:
  - `interface AgentEventMap` — 五个事件负载类型：
    ```ts
    export interface AgentEventMap {
      "step-start": { step: number; depth: number };
      "assistant-message": { text: string; depth: number };
      "tool-start": { id: string; toolName: string; input: unknown; depth: number };
      "tool-end": { id: string; toolName: string; result: string; isError: boolean; depth: number };
      "todo-changed": { todos: Todo[]; depth: number };
    }
    ```
  - `type AgentEventName = keyof AgentEventMap`
  - `interface AgentEvents { on<K extends AgentEventName>(event: K, listener: (payload: AgentEventMap[K]) => void): void; emit<K extends AgentEventName>(event: K, payload: AgentEventMap[K]): void; }`
  - `function createAgentEvents(): AgentEvents`

- [ ] **Step 1: 写失败的测试**

```ts
// test/events.test.ts
import { expect, test } from "bun:test";
import { createAgentEvents } from "@/core/events.js";

test("emit 按事件名分发给对应监听者", () => {
  const events = createAgentEvents();
  const stepPayloads: Array<{ step: number; depth: number }> = [];
  const toolPayloads: unknown[] = [];
  events.on("step-start", (payload) => stepPayloads.push(payload));
  events.on("tool-start", (payload) => toolPayloads.push(payload));

  events.emit("step-start", { step: 1, depth: 0 });
  events.emit("tool-start", { id: "t1", toolName: "bash", input: {}, depth: 0 });

  expect(stepPayloads).toEqual([{ step: 1, depth: 0 }]);
  expect(toolPayloads).toEqual([{ id: "t1", toolName: "bash", input: {}, depth: 0 }]);
});

test("同一事件支持多个监听者且互不影响", () => {
  const events = createAgentEvents();
  const calls: string[] = [];
  events.on("todo-changed", () => calls.push("a"));
  events.on("todo-changed", () => calls.push("b"));
  events.emit("todo-changed", { todos: [], depth: 0 });
  expect(calls).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/events.test.ts`
Expected: FAIL，报 `Cannot find module '@/core/events.js'` 或类似的解析错误。

- [ ] **Step 3: 实现 `src/core/events.ts`**

```ts
import type { Todo } from "@/core/state.js";

export interface AgentEventMap {
  "step-start": { step: number; depth: number };
  "assistant-message": { text: string; depth: number };
  "tool-start": { id: string; toolName: string; input: unknown; depth: number };
  "tool-end": { id: string; toolName: string; result: string; isError: boolean; depth: number };
  "todo-changed": { todos: Todo[]; depth: number };
}

export type AgentEventName = keyof AgentEventMap;

type Listener<K extends AgentEventName> = (payload: AgentEventMap[K]) => void;

export interface AgentEvents {
  on<K extends AgentEventName>(event: K, listener: Listener<K>): void;
  emit<K extends AgentEventName>(event: K, payload: AgentEventMap[K]): void;
}

export function createAgentEvents(): AgentEvents {
  const listeners = new Map<AgentEventName, Array<Listener<AgentEventName>>>();

  return {
    on(event, listener) {
      const bucket = listeners.get(event) ?? [];
      bucket.push(listener as Listener<AgentEventName>);
      listeners.set(event, bucket);
    },
    emit(event, payload) {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/events.test.ts`
Expected: PASS（2 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/core/events.ts test/events.test.ts
git commit -m "feat: 添加 AgentEvents 事件总线"
```

---

### Task 2: 在 `agentLoop` 中接入事件

**Files:**
- Modify: `src/core/loop.ts:1-133`（全文件，见下方具体改动点）
- Modify: `src/index.ts:1-14`（追加导出）
- Modify: `test/loop.test.ts`（追加一个新测试）

**Interfaces:**
- Consumes: Task 1 产出的 `AgentEvents`、`createAgentEvents`（来自 `@/core/events.js`）。
- Produces: `AgentLoopOptions` 新增可选字段 `events?: AgentEvents`；`agentLoop` 在下列时机 emit：
  - 每次 `state.steps += 1` 之后：emit `step-start`，payload `{ step: state.steps, depth: state.depth }`。
  - 模型回复推入 `state.messages` 之后，若过滤出的文本非空：emit `assistant-message`，payload `{ text, depth: state.depth }`。
  - 每个 `toolUse` 处理最开头（`PreToolUse` 触发之前）：emit `tool-start`，payload `{ id: toolUse.id, toolName: toolUse.name, input: toolUse.input, depth: state.depth }`。
  - 恰好 4 个分支各 emit 一次 `tool-end`（block / ask 拒绝 / dispatch 成功 / dispatch 抛错），payload `{ id, toolName, result, isError, depth: state.depth }`。
  - dispatch 成功且 `toolUse.name === "todo_write"`：额外 emit `todo-changed`，payload `{ todos: state.todos, depth: state.depth }`。

- [ ] **Step 1: 写失败的测试**

在 `test/loop.test.ts` 顶部的 import 中加入：

```ts
import { createAgentEvents } from "@/core/events.js";
```

在文件末尾（`useTestModel` 函数之后）追加：

```ts
test("events 依次触发 step-start/tool-start/tool-end/todo-changed/assistant-message", async () => {
  const requests: Array<{ messages: unknown[] }> = [];
  const server = createModelServer(requests, [
    [
      {
        type: "tool_use",
        id: "todo-1",
        name: "todo_write",
        input: { todos: [{ content: "写计划", status: "in_progress" }] },
      },
    ],
    [{ type: "text", text: "完成" }],
  ]);
  const restore = useTestModel(server.url.origin);
  const events = createAgentEvents();
  const seen: string[] = [];
  events.on("step-start", ({ step, depth }) => seen.push(`step-start:${step}:${depth}`));
  events.on("tool-start", ({ id, toolName, depth }) =>
    seen.push(`tool-start:${id}:${toolName}:${depth}`),
  );
  events.on("tool-end", ({ id, isError, depth }) => seen.push(`tool-end:${id}:${isError}:${depth}`));
  events.on("assistant-message", ({ text, depth }) => seen.push(`assistant-message:${text}:${depth}`));
  events.on("todo-changed", ({ todos, depth }) => seen.push(`todo-changed:${todos.length}:${depth}`));

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "写个计划" });
    await agentLoop(state, { events });

    expect(seen).toEqual([
      "step-start:1:0",
      "tool-start:todo-1:todo_write:0",
      "tool-end:todo-1:false:0",
      "todo-changed:1:0",
      "step-start:2:0",
      "assistant-message:完成:0",
    ]);
  } finally {
    restore();
    server.stop(true);
  }
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/loop.test.ts`
Expected: FAIL，新测试报 `seen` 为 `[]`（因为 `agentLoop` 还不认识 `events` 选项，不会 emit 任何事件）。

- [ ] **Step 3: 实现改动**

`src/core/loop.ts` 改动点：

1. 顶部 import 追加：
```ts
import type { AgentEvents } from "@/core/events.js";
```

2. `AgentLoopOptions` 接口追加字段：
```ts
export interface AgentLoopOptions {
  hooks?: HookBus;
  confirm?: (message: string) => Promise<boolean>;
  maxSteps?: number;
  maxStopRespawns?: number;
  skills?: SkillRegistry;
  events?: AgentEvents;
}
```

3. `state.steps += 1;` 之后追加一行：
```ts
    state.steps += 1;
    options.events?.emit("step-start", { step: state.steps, depth: state.depth });
```

4. `state.messages.push({ role: "assistant", content: response.content });` 之后追加：
```ts
    state.messages.push({ role: "assistant", content: response.content });
    const assistantText = response.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    if (assistantText) {
      options.events?.emit("assistant-message", { text: assistantText, depth: state.depth });
    }
```

5. `for (const toolUse of toolUses) {` 循环体整体替换为：
```ts
    for (const toolUse of toolUses) {
      options.events?.emit("tool-start", {
        id: toolUse.id,
        toolName: toolUse.name,
        input: toolUse.input,
        depth: state.depth,
      });

      const preToolUse = await options.hooks?.trigger("PreToolUse", {
        toolName: toolUse.name,
        input: toolUse.input,
      });
      if (preToolUse?.action === "block") {
        results.push(blockedResult(toolUse.id, preToolUse.reason));
        options.events?.emit("tool-end", {
          id: toolUse.id,
          toolName: toolUse.name,
          result: preToolUse.reason,
          isError: true,
          depth: state.depth,
        });
        continue;
      }
      if (preToolUse?.action === "ask") {
        const allowed = await options.confirm?.(preToolUse.message);
        if (!allowed) {
          const reason = "权限被拒：用户未批准";
          results.push(blockedResult(toolUse.id, reason));
          options.events?.emit("tool-end", {
            id: toolUse.id,
            toolName: toolUse.name,
            result: reason,
            isError: true,
            depth: state.depth,
          });
          continue;
        }
      }

      try {
        const result = await runtime.dispatch(toolUse.name, toolUse.input);
        const postToolUse = await options.hooks?.trigger("PostToolUse", {
          toolName: toolUse.name,
          input: toolUse.input,
          result,
        });
        const content =
          postToolUse?.action === "inject" ? `${result}\n${postToolUse.context}` : result;
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content,
        });
        options.events?.emit("tool-end", {
          id: toolUse.id,
          toolName: toolUse.name,
          result: content,
          isError: false,
          depth: state.depth,
        });
        if (toolUse.name === "todo_write") {
          options.events?.emit("todo-changed", { todos: state.todos, depth: state.depth });
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        results.push({
          type: "tool_result",
          tool_use_id: toolUse.id,
          content: message,
          is_error: true,
        });
        options.events?.emit("tool-end", {
          id: toolUse.id,
          toolName: toolUse.name,
          result: message,
          isError: true,
          depth: state.depth,
        });
      }
    }
```

`src/index.ts` 追加导出（放在 `export { createState } ...` 附近）：
```ts
export { createAgentEvents } from "@/core/events.js";
export type { AgentEventMap, AgentEventName, AgentEvents } from "@/core/events.js";
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/loop.test.ts`
Expected: PASS（全部既有测试 + 新测试）

- [ ] **Step 5: 提交**

```bash
git add src/core/loop.ts src/index.ts test/loop.test.ts
git commit -m "feat: agentLoop 接入 AgentEvents 事件广播"
```

---

### Task 3: 事件随子 Agent 深度透传

**Files:**
- Modify: `src/tools/task.ts:6-12`（`SubagentOptions` 接口）
- Modify: `test/runtime.test.ts`（追加一个新测试）

**Interfaces:**
- Consumes: Task 1 的 `AgentEvents`、Task 2 中 `agentLoop` 已支持的 `events` 选项。
- Produces: `SubagentOptions` 新增可选字段 `events?: AgentEvents`。因为 `src/core/loop.ts` 里 `spawnSubagent(description, state.depth, { ...options, skills }, agentLoop)` 已经把整个 `options`（含新的 `events`）展开传给子调用，此处不需要改动调用点，子 Agent 的 `agentLoop` 会自动收到同一个 `events` 实例，emit 时使用子 `state.depth`（父 depth + 1）。

- [ ] **Step 1: 写失败的测试**

在 `test/runtime.test.ts` 顶部 import 追加：
```ts
import { createAgentEvents } from "@/core/events.js";
```

在 `describe("v4 runtime", ...)` 块内、其他测试之后追加：

```ts
  test("events 携带 depth，子 Agent 的事件 depth 为父级 + 1", async () => {
    const requests: ModelRequest[] = [];
    const command = process.platform === "win32" ? "Write-Output child-ok" : "printf child-ok";
    const server = createModelServer(requests, [
      [{ type: "tool_use", id: "parent-task", name: "task", input: { description: "检查子任务" } }],
      [{ type: "tool_use", id: "child-bash", name: "bash", input: { command } }],
      [{ type: "text", text: "子任务结论" }],
      [{ type: "text", text: "父任务完成" }],
    ]);
    const restore = useTestModel(server.url.origin);
    const events = createAgentEvents();
    const depthsByToolStart: Record<string, number> = {};
    events.on("tool-start", ({ id, depth }) => {
      depthsByToolStart[id] = depth;
    });

    try {
      const state = createState();
      state.messages.push({ role: "user", content: "父级触发子任务" });
      await agentLoop(state, { events });

      expect(depthsByToolStart["parent-task"]).toBe(0);
      expect(depthsByToolStart["child-bash"]).toBe(1);
    } finally {
      restore();
      server.stop(true);
    }
  });
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/runtime.test.ts`
Expected: FAIL，`depthsByToolStart` 为 `{}`（`agentLoop(state, { events })` 尚未把 `events` 传给内部 `spawnSubagent` 调用所使用的 `SubagentOptions` 类型 —— 实际运行时值已经透传，但 TypeScript 会因 `SubagentOptions` 缺少 `events` 字段而报类型错误，导致该文件编译失败、测试无法运行）。

- [ ] **Step 3: 实现改动**

`src/tools/task.ts` 的 `SubagentOptions` 接口：
```ts
import type { AgentEvents } from "@/core/events.js";

export interface SubagentOptions {
  hooks?: HookBus;
  confirm?: (message: string) => Promise<boolean>;
  maxSteps?: number;
  maxStopRespawns?: number;
  skills?: SkillRegistry;
  events?: AgentEvents;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/runtime.test.ts`
Expected: PASS（全部既有测试 + 新测试）

- [ ] **Step 5: 提交**

```bash
git add src/tools/task.ts test/runtime.test.ts
git commit -m "feat: SubagentOptions 透传 AgentEvents"
```

---

### Task 4: `DisplayEntry` 显示日志（纯函数，无 Ink 依赖）

**Files:**
- Create: `src/tui/displayLog.ts`
- Test: `test/tui/displayLog.test.ts`

**Interfaces:**
- Consumes: 无（纯类型 + 纯函数，不依赖 core/hooks/tools）。
- Produces:
  ```ts
  export type DisplayEntry =
    | { kind: "user"; text: string }
    | { kind: "assistant"; text: string; depth: number }
    | {
        kind: "tool";
        id: string;
        toolName: string;
        input: unknown;
        depth: number;
        result?: string;
        isError?: boolean;
      }
    | { kind: "system"; text: string };

  export const MAX_DISPLAY_ENTRIES = 500;

  export function appendUserEntry(log: DisplayEntry[], text: string): DisplayEntry[];
  export function appendSystemEntry(log: DisplayEntry[], text: string): DisplayEntry[];
  export function appendAssistantMessage(
    log: DisplayEntry[],
    payload: { text: string; depth: number },
  ): DisplayEntry[];
  export function appendToolStart(
    log: DisplayEntry[],
    payload: { id: string; toolName: string; input: unknown; depth: number },
  ): DisplayEntry[];
  export function applyToolEnd(
    log: DisplayEntry[],
    payload: { id: string; result: string; isError: boolean },
  ): DisplayEntry[];
  ```
  这些签名的字段名（`kind`、`toolName`、`depth`、`result`、`isError`）会被 Task 9 的 `MessageList.tsx` 和 Task 11 的 `App.tsx` 直接使用。

- [ ] **Step 1: 写失败的测试**

```ts
// test/tui/displayLog.test.ts
import { expect, test } from "bun:test";
import {
  appendAssistantMessage,
  appendSystemEntry,
  appendToolStart,
  appendUserEntry,
  applyToolEnd,
  MAX_DISPLAY_ENTRIES,
  type DisplayEntry,
} from "@/tui/displayLog.js";

test("append* 依次追加条目", () => {
  let log = appendUserEntry([], "你好");
  log = appendAssistantMessage(log, { text: "收到", depth: 0 });
  log = appendSystemEntry(log, "系统提示");
  expect(log).toEqual([
    { kind: "user", text: "你好" },
    { kind: "assistant", text: "收到", depth: 0 },
    { kind: "system", text: "系统提示" },
  ]);
});

test("applyToolEnd 按 id 回填结果", () => {
  let log = appendToolStart([], { id: "t1", toolName: "bash", input: { command: "ls" }, depth: 0 });
  log = applyToolEnd(log, { id: "t1", result: "ok", isError: false });
  expect(log).toEqual([
    { kind: "tool", id: "t1", toolName: "bash", input: { command: "ls" }, depth: 0, result: "ok", isError: false },
  ]);
});

test("applyToolEnd 找不到匹配 id 时原样返回", () => {
  const log = appendToolStart([], { id: "t1", toolName: "bash", input: {}, depth: 0 });
  expect(applyToolEnd(log, { id: "missing", result: "ok", isError: false })).toBe(log);
});

test("超过 500 条时从头部丢弃", () => {
  let log: DisplayEntry[] = [];
  for (let i = 0; i < MAX_DISPLAY_ENTRIES + 10; i += 1) {
    log = appendUserEntry(log, `消息${i}`);
  }
  expect(log).toHaveLength(MAX_DISPLAY_ENTRIES);
  expect(log[0]).toEqual({ kind: "user", text: "消息10" });
  expect(log.at(-1)).toEqual({ kind: "user", text: `消息${MAX_DISPLAY_ENTRIES + 9}` });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/displayLog.test.ts`
Expected: FAIL，报 `Cannot find module '@/tui/displayLog.js'`。

- [ ] **Step 3: 实现 `src/tui/displayLog.ts`**

```ts
export type DisplayEntry =
  | { kind: "user"; text: string }
  | { kind: "assistant"; text: string; depth: number }
  | {
      kind: "tool";
      id: string;
      toolName: string;
      input: unknown;
      depth: number;
      result?: string;
      isError?: boolean;
    }
  | { kind: "system"; text: string };

export const MAX_DISPLAY_ENTRIES = 500;

export function appendUserEntry(log: DisplayEntry[], text: string): DisplayEntry[] {
  return cap([...log, { kind: "user", text }]);
}

export function appendSystemEntry(log: DisplayEntry[], text: string): DisplayEntry[] {
  return cap([...log, { kind: "system", text }]);
}

export function appendAssistantMessage(
  log: DisplayEntry[],
  payload: { text: string; depth: number },
): DisplayEntry[] {
  return cap([...log, { kind: "assistant", text: payload.text, depth: payload.depth }]);
}

export function appendToolStart(
  log: DisplayEntry[],
  payload: { id: string; toolName: string; input: unknown; depth: number },
): DisplayEntry[] {
  return cap([
    ...log,
    {
      kind: "tool",
      id: payload.id,
      toolName: payload.toolName,
      input: payload.input,
      depth: payload.depth,
    },
  ]);
}

export function applyToolEnd(
  log: DisplayEntry[],
  payload: { id: string; result: string; isError: boolean },
): DisplayEntry[] {
  const index = log.findIndex((entry) => entry.kind === "tool" && entry.id === payload.id);
  if (index === -1) return log;
  const next = [...log];
  const target = next[index] as Extract<DisplayEntry, { kind: "tool" }>;
  next[index] = { ...target, result: payload.result, isError: payload.isError };
  return next;
}

function cap(log: DisplayEntry[]): DisplayEntry[] {
  return log.length > MAX_DISPLAY_ENTRIES ? log.slice(log.length - MAX_DISPLAY_ENTRIES) : log;
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/tui/displayLog.test.ts`
Expected: PASS（4 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/tui/displayLog.ts test/tui/displayLog.test.ts
git commit -m "feat: 添加 DisplayEntry 显示日志纯函数"
```

---

### Task 5: `ConfirmBridge`

**Files:**
- Create: `src/tui/confirmBridge.ts`
- Test: `test/tui/confirmBridge.test.ts`

**Interfaces:**
- Consumes: 无。
- Produces:
  ```ts
  export interface ConfirmRequest {
    message: string;
    respond: (allowed: boolean) => void;
  }

  export interface ConfirmBridge {
    confirm: (message: string) => Promise<boolean>;
    subscribe: (listener: (request: ConfirmRequest) => void) => void;
  }

  export function createConfirmBridge(): ConfirmBridge;
  ```
  `confirm` 的签名与 `AgentLoopOptions.confirm`（`src/core/loop.ts`）完全一致，Task 11 会把 `confirmBridge.confirm` 直接作为 `agentLoop` 的 `confirm` 选项传入。

- [ ] **Step 1: 写失败的测试**

```ts
// test/tui/confirmBridge.test.ts
import { expect, test } from "bun:test";
import { createConfirmBridge } from "@/tui/confirmBridge.js";

test("subscribe 的监听者收到 confirm 请求，respond 后 confirm 的 Promise 相应 resolve", async () => {
  const bridge = createConfirmBridge();
  let received: { message: string } | undefined;
  bridge.subscribe((request) => {
    received = { message: request.message };
    request.respond(true);
  });

  const allowed = await bridge.confirm("允许执行 bash 吗？");

  expect(received).toEqual({ message: "允许执行 bash 吗？" });
  expect(allowed).toBe(true);
});

test("respond(false) 时 confirm 的 Promise resolve 为 false", async () => {
  const bridge = createConfirmBridge();
  bridge.subscribe((request) => request.respond(false));

  await expect(bridge.confirm("危险操作")).resolves.toBe(false);
});

test("没有订阅者时 confirm 直接 resolve 为 false", async () => {
  const bridge = createConfirmBridge();
  await expect(bridge.confirm("无人处理")).resolves.toBe(false);
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/confirmBridge.test.ts`
Expected: FAIL，报 `Cannot find module '@/tui/confirmBridge.js'`。

- [ ] **Step 3: 实现 `src/tui/confirmBridge.ts`**

```ts
export interface ConfirmRequest {
  message: string;
  respond: (allowed: boolean) => void;
}

export interface ConfirmBridge {
  confirm: (message: string) => Promise<boolean>;
  subscribe: (listener: (request: ConfirmRequest) => void) => void;
}

export function createConfirmBridge(): ConfirmBridge {
  let listener: ((request: ConfirmRequest) => void) | undefined;

  return {
    confirm(message) {
      return new Promise<boolean>((resolve) => {
        if (!listener) {
          resolve(false);
          return;
        }
        listener({ message, respond: resolve });
      });
    },
    subscribe(fn) {
      listener = fn;
    },
  };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/tui/confirmBridge.test.ts`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/tui/confirmBridge.ts test/tui/confirmBridge.test.ts
git commit -m "feat: 添加 ConfirmBridge 解耦 confirm 回调"
```

---

### Task 6: 引入 Ink 工具链 + `ConfirmModal`

**Files:**
- Modify: `package.json:29-38`（依赖）
- Modify: `tsconfig.json:2-13`（`jsx`、`types`）
- Create: `src/tui/ConfirmModal.tsx`
- Test: `test/tui/ConfirmModal.test.tsx`

**Interfaces:**
- Consumes: Task 5 的 `ConfirmRequest`（来自 `@/tui/confirmBridge.js`）。
- Produces: `ConfirmModal(props: { request: ConfirmRequest }): JSX.Element` —— 按 `y`/`Y` 调用 `request.respond(true)`，按 `n`/`N`/Esc 调用 `request.respond(false)`。

- [ ] **Step 1: 安装依赖并修正 tsconfig**

`package.json` 的 `dependencies` 块改为：
```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "dotenv": "^16.6.1",
    "glob": "^13.0.6",
    "ink": "^5.2.1",
    "react": "^18.3.1"
  },
```

`package.json` 的 `devDependencies` 块改为：
```json
  "devDependencies": {
    "@types/bun": "latest",
    "@types/react": "^18.3.31",
    "ink-testing-library": "^4.0.0",
    "tsc-alias": "^1.9.1",
    "typescript": "^5.5.0"
  }
```

Run: `bun install`
Expected: 安装成功，`bun.lock`（或 `bun.lockb`）更新，无 peer dependency 冲突（已通过 `npm view ink@5.2.1 / react@18.3.1 / @types/react@18.3.31 peerDependencies` 确认互相兼容且 `engines.node` 均为 `>=18`）。

`tsconfig.json` 的 `compilerOptions` 块改为：
```json
  "compilerOptions": {
    "target": "ES2022",
    "module": "Preserve",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "paths": {
      "@/*": ["./src/*"]
    },
    "strict": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["bun", "react"]
  },
```

> `types` 数组会限制自动加载哪些 `@types/*` 包；不把 `"react"` 加进去，即使装了 `@types/react`，TypeScript 也不会识别 JSX 类型。

- [ ] **Step 2: 写失败的测试**

```tsx
// test/tui/ConfirmModal.test.tsx
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { ConfirmModal } from "@/tui/ConfirmModal.js";
import type { ConfirmRequest } from "@/tui/confirmBridge.js";

test("展示确认消息，按 y 触发 respond(true)", () => {
  let resolved: boolean | undefined;
  const request: ConfirmRequest = {
    message: "允许执行 ls 吗？",
    respond: (value) => {
      resolved = value;
    },
  };
  const { stdin, lastFrame } = render(<ConfirmModal request={request} />);

  expect(lastFrame()).toContain("允许执行 ls 吗？");
  stdin.write("y");
  expect(resolved).toBe(true);
});

test("按 n 触发 respond(false)", () => {
  let resolved: boolean | undefined;
  const request: ConfirmRequest = {
    message: "允许执行 rm 吗？",
    respond: (value) => {
      resolved = value;
    },
  };
  const { stdin } = render(<ConfirmModal request={request} />);

  stdin.write("n");
  expect(resolved).toBe(false);
});

test("方向键切换选中项后按 Enter 触发对应的 respond", () => {
  let resolved: boolean | undefined;
  const request: ConfirmRequest = {
    message: "允许执行 rm 吗？",
    respond: (value) => {
      resolved = value;
    },
  };
  const { stdin } = render(<ConfirmModal request={request} />);

  stdin.write("[C"); // 右方向键：从默认选中的"允许"切到"拒绝"
  stdin.write("\r"); // Enter 确认当前选中项

  expect(resolved).toBe(false);
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test test/tui/ConfirmModal.test.tsx`
Expected: FAIL，报 `Cannot find module '@/tui/ConfirmModal.js'`。

- [ ] **Step 4: 实现 `src/tui/ConfirmModal.tsx`**

```tsx
import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ConfirmRequest } from "@/tui/confirmBridge.js";

export interface ConfirmModalProps {
  request: ConfirmRequest;
}

export function ConfirmModal({ request }: ConfirmModalProps): JSX.Element {
  const [selected, setSelected] = useState<"allow" | "deny">("allow");

  useInput((input, key) => {
    if (input.toLowerCase() === "y") {
      request.respond(true);
      return;
    }
    if (input.toLowerCase() === "n") {
      request.respond(false);
      return;
    }
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelected((current) => (current === "allow" ? "deny" : "allow"));
      return;
    }
    if (key.return) {
      request.respond(selected === "allow");
      return;
    }
    if (key.escape) {
      request.respond(false);
    }
  });

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text>{request.message}</Text>
      <Text>
        <Text color={selected === "allow" ? "green" : undefined} bold={selected === "allow"}>
          {selected === "allow" ? "> 允许" : "  允许"}
        </Text>
        {"  "}
        <Text color={selected === "deny" ? "red" : undefined} bold={selected === "deny"}>
          {selected === "deny" ? "> 拒绝" : "  拒绝"}
        </Text>
      </Text>
      <Text dimColor>[y] 允许 · [n] 拒绝 · ←/→ 切换 · Enter 确认</Text>
    </Box>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test test/tui/ConfirmModal.test.tsx`
Expected: PASS（3 个测试）

- [ ] **Step 6: 提交**

```bash
git add package.json tsconfig.json src/tui/ConfirmModal.tsx test/tui/ConfirmModal.test.tsx
git commit -m "feat: 引入 Ink 工具链，添加 ConfirmModal 组件"
```

---

### Task 7: `StatusBar`

**Files:**
- Modify: `package.json`（追加 `ink-spinner` 依赖）
- Create: `src/tui/StatusBar.tsx`
- Test: `test/tui/StatusBar.test.tsx`

**Interfaces:**
- Consumes: 无跨任务依赖。
- Produces: `StatusBar(props: { cwd: string; model: string; step: number; busy: boolean }): JSX.Element`。Task 11 的 `App.tsx` 会用 `getModelId()`（`@/config.js`）的返回值填 `model`。

- [ ] **Step 1: 安装依赖**

`package.json` 的 `dependencies` 追加 `"ink-spinner": "^5.0.0"`（已通过 `npm view ink-spinner@5.0.0 peerDependencies` 确认兼容 `ink >=4.0.0`、`react >=18.0.0`）：
```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "dotenv": "^16.6.1",
    "glob": "^13.0.6",
    "ink": "^5.2.1",
    "ink-spinner": "^5.0.0",
    "react": "^18.3.1"
  },
```

Run: `bun install`
Expected: 安装成功。

- [ ] **Step 2: 写失败的测试**

```tsx
// test/tui/StatusBar.test.tsx
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "@/tui/StatusBar.js";

test("展示工作目录、模型与步数", () => {
  const { lastFrame } = render(
    <StatusBar cwd="/workspace" model="claude-sonnet-5" step={3} busy={false} />,
  );
  const frame = lastFrame();
  expect(frame).toContain("/workspace");
  expect(frame).toContain("claude-sonnet-5");
  expect(frame).toContain("3");
  expect(frame).not.toContain("执行中");
});

test("busy 为 true 时展示执行中提示", () => {
  const { lastFrame } = render(
    <StatusBar cwd="/workspace" model="claude-sonnet-5" step={1} busy />,
  );
  expect(lastFrame()).toContain("执行中");
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test test/tui/StatusBar.test.tsx`
Expected: FAIL，报 `Cannot find module '@/tui/StatusBar.js'`。

- [ ] **Step 4: 实现 `src/tui/StatusBar.tsx`**

```tsx
import { Box, Text } from "ink";
import Spinner from "ink-spinner";

export interface StatusBarProps {
  cwd: string;
  model: string;
  step: number;
  busy: boolean;
}

export function StatusBar({ cwd, model, step, busy }: StatusBarProps): JSX.Element {
  return (
    <Box>
      <Text dimColor>
        {cwd} · {model} · step {step}
      </Text>
      {busy ? (
        <Text color="yellow">
          {" "}
          <Spinner type="dots" /> 执行中…
        </Text>
      ) : null}
    </Box>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test test/tui/StatusBar.test.tsx`
Expected: PASS（2 个测试）

- [ ] **Step 6: 提交**

```bash
git add package.json src/tui/StatusBar.tsx test/tui/StatusBar.test.tsx
git commit -m "feat: 添加 StatusBar 组件"
```

---

### Task 8: `TodoPanel`

**Files:**
- Modify: `src/tools/todo.ts:3-7`（导出 `STATUS_MARKS`）
- Create: `src/tui/TodoPanel.tsx`
- Test: `test/tui/TodoPanel.test.tsx`

**Interfaces:**
- Consumes: `Todo`、`TodoStatus`（来自 `@/core/state.js`）；`STATUS_MARKS`（来自 `@/tools/todo.js`，本任务改为导出）。
- Produces: `TodoPanel(props: { todos: Todo[] }): JSX.Element | null` —— `todos` 为空数组时返回 `null`（不渲染任何内容）。

- [ ] **Step 1: 写失败的测试**

```tsx
// test/tui/TodoPanel.test.tsx
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { TodoPanel } from "@/tui/TodoPanel.js";

test("todos 为空时不渲染任何内容", () => {
  const { lastFrame } = render(<TodoPanel todos={[]} />);
  expect(lastFrame()).toBe("");
});

test("按状态展示每一条 todo", () => {
  const { lastFrame } = render(
    <TodoPanel
      todos={[
        { content: "写测试", status: "completed" },
        { content: "写实现", status: "in_progress" },
        { content: "写文档", status: "pending" },
      ]}
    />,
  );
  const frame = lastFrame();
  expect(frame).toContain("[x] 写测试");
  expect(frame).toContain("[>] 写实现");
  expect(frame).toContain("[ ] 写文档");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/TodoPanel.test.tsx`
Expected: FAIL，报 `Cannot find module '@/tui/TodoPanel.js'`。

- [ ] **Step 3: 实现改动**

`src/tools/todo.ts` 第 3-7 行由：
```ts
const STATUS_MARKS: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: ">",
  completed: "x",
};
```
改为：
```ts
export const STATUS_MARKS: Record<TodoStatus, string> = {
  pending: " ",
  in_progress: ">",
  completed: "x",
};
```

`src/tui/TodoPanel.tsx`：
```tsx
import { Box, Text } from "ink";
import type { Todo } from "@/core/state.js";
import { STATUS_MARKS } from "@/tools/todo.js";

export interface TodoPanelProps {
  todos: Todo[];
}

export function TodoPanel({ todos }: TodoPanelProps): JSX.Element | null {
  if (todos.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {todos.map((todo, index) => (
        <Text key={`${index}-${todo.content}`}>
          [{STATUS_MARKS[todo.status]}] {todo.content}
        </Text>
      ))}
    </Box>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/tui/TodoPanel.test.tsx`
Expected: PASS（2 个测试）

- [ ] **Step 5: 确认没有破坏既有 todo 测试**

Run: `bun test test/todo.test.ts`
Expected: PASS（`STATUS_MARKS` 改为具名导出不影响其原有用法）

- [ ] **Step 6: 提交**

```bash
git add src/tools/todo.ts src/tui/TodoPanel.tsx test/tui/TodoPanel.test.tsx
git commit -m "feat: 添加 TodoPanel 组件，导出 STATUS_MARKS 复用"
```

---

### Task 9: `MessageList`

**Files:**
- Create: `src/tui/MessageList.tsx`
- Test: `test/tui/MessageList.test.tsx`

**Interfaces:**
- Consumes: `DisplayEntry`（来自 `@/tui/displayLog.js`，Task 4 产出）。
- Produces: `MessageList(props: { entries: DisplayEntry[] }): JSX.Element`。

- [ ] **Step 1: 写失败的测试**

```tsx
// test/tui/MessageList.test.tsx
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { MessageList } from "@/tui/MessageList.js";
import type { DisplayEntry } from "@/tui/displayLog.js";

test("渲染用户、助手、系统条目", () => {
  const entries: DisplayEntry[] = [
    { kind: "user", text: "你好" },
    { kind: "assistant", text: "你好，我是助手", depth: 0 },
    { kind: "system", text: "已达到最大步数" },
  ];
  const frame = render(<MessageList entries={entries} />).lastFrame();
  expect(frame).toContain("你好");
  expect(frame).toContain("你好，我是助手");
  expect(frame).toContain("已达到最大步数");
});

test("子 Agent（depth > 0）的条目带缩进标记", () => {
  const entries: DisplayEntry[] = [
    { kind: "assistant", text: "子任务结论", depth: 1 },
  ];
  const frame = render(<MessageList entries={entries} />).lastFrame();
  expect(frame).toContain("↳");
  expect(frame).toContain("子任务结论");
});

test("工具条目在运行中与完成后展示不同状态", () => {
  const running: DisplayEntry[] = [
    { kind: "tool", id: "t1", toolName: "bash", input: {}, depth: 0 },
  ];
  expect(render(<MessageList entries={running} />).lastFrame()).toContain("运行中");

  const done: DisplayEntry[] = [
    { kind: "tool", id: "t1", toolName: "bash", input: {}, depth: 0, result: "ok", isError: false },
  ];
  const doneFrame = render(<MessageList entries={done} />).lastFrame();
  expect(doneFrame).toContain("完成");
  expect(doneFrame).toContain("ok");
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/MessageList.test.tsx`
Expected: FAIL，报 `Cannot find module '@/tui/MessageList.js'`。

- [ ] **Step 3: 实现 `src/tui/MessageList.tsx`**

```tsx
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
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/tui/MessageList.test.tsx`
Expected: PASS（3 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/tui/MessageList.tsx test/tui/MessageList.test.tsx
git commit -m "feat: 添加 MessageList 组件"
```

---

### Task 10: `InputBox`

**Files:**
- Modify: `package.json`（追加 `ink-text-input` 依赖）
- Create: `src/tui/InputBox.tsx`
- Test: `test/tui/InputBox.test.tsx`

**Interfaces:**
- Consumes: 无跨任务依赖。
- Produces: `InputBox(props: { value: string; onChange: (value: string) => void; onSubmit: (value: string) => void; disabled: boolean }): JSX.Element`。

- [ ] **Step 1: 安装依赖**

`package.json` 的 `dependencies` 追加 `"ink-text-input": "^6.0.0"`（已通过 `npm view ink-text-input@6.0.0 peerDependencies` 确认兼容 `ink >=5`、`react >=18`）：
```json
  "dependencies": {
    "@anthropic-ai/sdk": "^0.40.0",
    "dotenv": "^16.6.1",
    "glob": "^13.0.6",
    "ink": "^5.2.1",
    "ink-spinner": "^5.0.0",
    "ink-text-input": "^6.0.0",
    "react": "^18.3.1"
  },
```

Run: `bun install`
Expected: 安装成功。

- [ ] **Step 2: 写失败的测试**

```tsx
// test/tui/InputBox.test.tsx
import { useState } from "react";
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { InputBox } from "@/tui/InputBox.js";

test("禁用时展示提示文本而不接收输入", () => {
  const { lastFrame } = render(
    <InputBox value="" onChange={() => {}} onSubmit={() => {}} disabled />,
  );
  expect(lastFrame()).toContain("请稍候");
});

test("启用时输入字符会触发 onChange", () => {
  function Harness() {
    const [value, setValue] = useState("");
    return <InputBox value={value} onChange={setValue} onSubmit={() => {}} disabled={false} />;
  }
  const { stdin, lastFrame } = render(<Harness />);

  stdin.write("hi");

  expect(lastFrame()).toContain("hi");
});
```

- [ ] **Step 3: 运行测试确认失败**

Run: `bun test test/tui/InputBox.test.tsx`
Expected: FAIL，报 `Cannot find module '@/tui/InputBox.js'`。

- [ ] **Step 4: 实现 `src/tui/InputBox.tsx`**

```tsx
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function InputBox({ value, onChange, onSubmit, disabled }: InputBoxProps): JSX.Element {
  if (disabled) {
    return (
      <Box>
        <Text dimColor>请稍候…</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text>{"> "}</Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test test/tui/InputBox.test.tsx`
Expected: PASS（2 个测试）

- [ ] **Step 6: 提交**

```bash
git add package.json src/tui/InputBox.tsx test/tui/InputBox.test.tsx
git commit -m "feat: 添加 InputBox 组件"
```

---

### Task 11: `App` 集成组件

**Files:**
- Create: `src/tui/App.tsx`
- Test: `test/tui/App.test.tsx`

**Interfaces:**
- Consumes:
  - `agentLoop`、`MaxStepsExceededError`（`@/core/loop.js`）
  - `createState`、`State`（`@/core/state.js`）
  - `createAgentEvents`（`@/core/events.js`，Task 1）
  - `HookBus`（`@/hooks/bus.js`）
  - `SkillRegistry`（`@/tools/skill.js`）
  - `getModelId`（`@/config.js`）
  - `createConfirmBridge`、`ConfirmRequest`（`@/tui/confirmBridge.js`，Task 5）
  - `appendUserEntry`、`appendSystemEntry`、`appendAssistantMessage`、`appendToolStart`、`applyToolEnd`、`DisplayEntry`（`@/tui/displayLog.js`，Task 4）
  - `MessageList`（Task 9）、`StatusBar`（Task 7）、`TodoPanel`（Task 8）、`ConfirmModal`（Task 6）、`InputBox`（Task 10）
- Produces: `App(props: { workingDirectory: string; hooks: HookBus; skills: SkillRegistry }): JSX.Element` —— Task 12 的 `src/cli/main.ts` 会直接挂载它。

- [ ] **Step 1: 写失败的测试**

```tsx
// test/tui/App.test.tsx
import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "@/tui/App.js";
import { HookBus } from "@/hooks/bus.js";
import type { SkillRegistry } from "@/tools/skill.js";

const emptySkills: SkillRegistry = new Map();

function createModelServer(responses: unknown[][]): ReturnType<typeof Bun.serve> {
  let index = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      const content = responses[index++] ?? responses.at(-1) ?? [];
      const usesTool = content.some(
        (block) =>
          typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use",
      );
      return Response.json({
        id: `message-${index}`,
        type: "message",
        role: "assistant",
        model: "test-model",
        content,
        stop_reason: usesTool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
}

function useTestModel(baseUrl: string): () => void {
  const previous = [process.env.API_KEY, process.env.BASE_URL, process.env.MODEL_ID];
  process.env.API_KEY = "test-key";
  process.env.BASE_URL = baseUrl;
  process.env.MODEL_ID = "test-model";
  return () => {
    restoreEnvironment("API_KEY", previous[0]);
    restoreEnvironment("BASE_URL", previous[1]);
    restoreEnvironment("MODEL_ID", previous[2]);
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 10));
}

test("提交问题后渲染用户输入与模型回复", async () => {
  const server = createModelServer([[{ type: "text", text: "你好，我是助手" }]]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();

  try {
    const { stdin, lastFrame } = render(
      <App workingDirectory="/tmp" hooks={hooks} skills={emptySkills} />,
    );
    stdin.write("你好\r");
    await flush();

    expect(lastFrame()).toContain("你好");
    expect(lastFrame()).toContain("你好，我是助手");
  } finally {
    restore();
    server.stop(true);
  }
});

test("PreToolUse 请求确认时展示 ConfirmModal，批准后继续执行并关闭弹层", async () => {
  const command = process.platform === "win32" ? "Write-Output ok" : "printf ok";
  const server = createModelServer([
    [{ type: "tool_use", id: "ask-1", name: "bash", input: { command } }],
    [{ type: "text", text: "执行完成" }],
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();
  hooks.register("PreToolUse", () => ({ action: "ask", message: "允许执行 bash 吗？" }));

  try {
    const { stdin, lastFrame } = render(
      <App workingDirectory="/tmp" hooks={hooks} skills={emptySkills} />,
    );
    stdin.write("跑一下\r");
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

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/tui/App.test.tsx`
Expected: FAIL，报 `Cannot find module '@/tui/App.js'`。

- [ ] **Step 3: 实现 `src/tui/App.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { Box } from "ink";
import { getModelId } from "@/config.js";
import { agentLoop, MaxStepsExceededError } from "@/core/loop.js";
import { createAgentEvents } from "@/core/events.js";
import { createState, type State, type Todo } from "@/core/state.js";
import type { HookBus } from "@/hooks/bus.js";
import type { SkillRegistry } from "@/tools/skill.js";
import { ConfirmModal } from "@/tui/ConfirmModal.js";
import { createConfirmBridge, type ConfirmRequest } from "@/tui/confirmBridge.js";
import {
  appendAssistantMessage,
  appendSystemEntry,
  appendToolStart,
  appendUserEntry,
  applyToolEnd,
  type DisplayEntry,
} from "@/tui/displayLog.js";
import { InputBox } from "@/tui/InputBox.js";
import { MessageList } from "@/tui/MessageList.js";
import { StatusBar } from "@/tui/StatusBar.js";
import { TodoPanel } from "@/tui/TodoPanel.js";

export interface AppProps {
  workingDirectory: string;
  hooks: HookBus;
  skills: SkillRegistry;
}

export function App({ workingDirectory, hooks, skills }: AppProps): JSX.Element {
  const stateRef = useRef<State>();
  if (!stateRef.current) stateRef.current = createState();
  const eventsRef = useRef(createAgentEvents());
  const confirmBridgeRef = useRef(createConfirmBridge());

  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | undefined>();

  useEffect(() => {
    const events = eventsRef.current;
    events.on("step-start", ({ step: nextStep }) => setStep(nextStep));
    events.on("assistant-message", ({ text, depth }) =>
      setEntries((log) => appendAssistantMessage(log, { text, depth })),
    );
    events.on("tool-start", (payload) => setEntries((log) => appendToolStart(log, payload)));
    events.on("tool-end", (payload) => setEntries((log) => applyToolEnd(log, payload)));
    events.on("todo-changed", ({ todos: nextTodos }) => setTodos(nextTodos));
    confirmBridgeRef.current.subscribe((request) => setPendingConfirm(request));
  }, []);

  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    setEntries((log) => appendUserEntry(log, trimmed));
    setBusy(true);

    const state = stateRef.current!;
    const promptHook = await hooks.trigger("UserPromptSubmit", { prompt: trimmed });
    const content =
      promptHook.action === "inject" ? `${trimmed}\n${promptHook.context}` : trimmed;
    state.messages.push({ role: "user", content });

    try {
      await agentLoop(state, {
        hooks,
        skills,
        events: eventsRef.current,
        confirm: confirmBridgeRef.current.confirm,
      });
    } catch (error) {
      const message =
        error instanceof MaxStepsExceededError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      setEntries((log) => appendSystemEntry(log, message));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmResolve = (value: boolean): void => {
    pendingConfirm?.respond(value);
    setPendingConfirm(undefined);
  };

  return (
    <Box flexDirection="column">
      <MessageList entries={entries} />
      <TodoPanel todos={todos} />
      {pendingConfirm ? (
        <ConfirmModal
          request={{ message: pendingConfirm.message, respond: handleConfirmResolve }}
        />
      ) : (
        <InputBox value={input} onChange={setInput} onSubmit={handleSubmit} disabled={busy} />
      )}
      <StatusBar cwd={workingDirectory} model={getModelId()} step={step} busy={busy} />
    </Box>
  );
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/tui/App.test.tsx`
Expected: PASS（2 个测试）

- [ ] **Step 5: 提交**

```bash
git add src/tui/App.tsx test/tui/App.test.tsx
git commit -m "feat: 添加 App 集成组件"
```

---

### Task 12: CLI 挂载 Ink，移除 readline 与 `render.ts`

**Files:**
- Modify: `src/cli/main.ts:1-73`（整体替换）
- Delete: `src/cli/render.ts`
- Modify: `test/index.test.ts:1-9`（追加 TTY 判定测试）

**Interfaces:**
- Consumes: `App`（`@/tui/App.js`，Task 11）。
- Produces: `parseWorkingDirectory(args: string[]): string`（不变，供 `test/index.test.ts` 既有测试使用）；新增导出 `shouldUseTui(input: NodeJS.ReadStream, output: NodeJS.WriteStream): boolean`，供测试直接验证 TTY 判定逻辑而不必真的启动 Ink。

- [ ] **Step 1: 写失败的测试**

在 `test/index.test.ts` 顶部 import 追加 `shouldUseTui`：
```ts
import { parseWorkingDirectory, shouldUseTui } from "@/cli/main.js";
```

在 `describe("工作目录", ...)` 块之后追加：
```ts
describe("TTI 判定", () => {
  test("stdin 与 stdout 都是 TTY 时才使用 TUI", () => {
    expect(shouldUseTui({ isTTY: true } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream)).toBe(
      true,
    );
    expect(
      shouldUseTui({ isTTY: false } as NodeJS.ReadStream, { isTTY: true } as NodeJS.WriteStream),
    ).toBe(false);
    expect(
      shouldUseTui({ isTTY: true } as NodeJS.ReadStream, { isTTY: false } as NodeJS.WriteStream),
    ).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `bun test test/index.test.ts`
Expected: FAIL，报 `shouldUseTui` 不是 `@/cli/main.js` 的导出成员。

- [ ] **Step 3: 实现改动**

删除 `src/cli/render.ts`（其职责由 `MessageList.tsx` 取代，且已通过 grep 确认只被 `src/cli/main.ts` 引用）。

`src/cli/main.ts` 整体替换为：
```ts
#!/usr/bin/env node

import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { render } from "ink";
import { createElement } from "react";
import { createDefaultHookBus } from "@/hooks/index.js";
import { scanSkills } from "@/tools/skill.js";
import { App } from "@/tui/App.js";

export function parseWorkingDirectory(args: string[]): string {
  const cwdIndex = args.indexOf("--cwd");
  if (cwdIndex === -1) return resolve(process.cwd());
  const directory = args[cwdIndex + 1];
  if (!directory) throw new Error("--cwd 后需要目录路径");
  return resolve(directory);
}

export function shouldUseTui(input: NodeJS.ReadStream, output: NodeJS.WriteStream): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const workingDirectory = parseWorkingDirectory(args);
  process.chdir(workingDirectory);

  if (!shouldUseTui(stdin, stdout)) {
    stdout.write("mini-agent 的交互式界面需要在终端（TTY）中运行。\n");
    process.exitCode = 1;
    return;
  }

  const skills = await scanSkills();
  const hooks = createDefaultHookBus();
  const { waitUntilExit } = render(createElement(App, { workingDirectory, hooks, skills }));
  await waitUntilExit();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `bun test test/index.test.ts`
Expected: PASS（既有测试 + 新增 TTY 判定测试）

- [ ] **Step 5: 运行完整测试套件与类型检查**

Run: `bun test`
Expected: 除已知的、与本计划无关的 `test/builtins.test.ts`（`createAutoGitAddHook` 缺失导出）外全部 PASS。

Run: `bun run typecheck`
Expected: 除 `test/builtins.test.ts(5,27): error TS2724` 这条已知的、与本计划无关的预先存在错误外，无其他类型错误。

- [ ] **Step 6: 手动验证**

Run: `bun run dev`
Expected: 在真实终端中看到 Ink 渲染的界面（消息区 + Todo 面板 + 输入框 + 状态栏），输入一句话后能看到用户消息、助手回复、以及需要确认时的 `ConfirmModal` 弹层；退出方式为 Ctrl+C（默认 SIGINT 行为，未做拦截）。

- [ ] **Step 7: 提交**

```bash
git add src/cli/main.ts test/index.test.ts
git rm src/cli/render.ts
git commit -m "feat: CLI 挂载 Ink TUI，移除 readline 与 render.ts"
```

---

## 自查记录

**Spec 覆盖检查：**
- 消息历史滚动区 + 输入框 → Task 9（MessageList）+ Task 10（InputBox）+ Task 11（App 集成）。
- 底部状态栏 → Task 7（StatusBar）。
- Todo 面板 → Task 8（TodoPanel）。
- 交互式权限确认弹层 → Task 6（ConfirmModal）+ Task 5（ConfirmBridge）。
- 工具执行实时可见性 → Task 2（`tool-start`/`tool-end` 严格配对）+ Task 4（`appendToolStart`/`applyToolEnd`）。
- 事件契约（`AgentEventMap`、depth 透传）→ Task 1、Task 2、Task 3。
- 非 TTY 报错退出 → Task 12（`shouldUseTui`）。
- `src/tui` 与核心逻辑解耦、不污染原逻辑 → 全程通过 `events?`/`confirm` 可选字段扩展，`src/core`/`src/hooks`/`src/tools` 无 import 指向 `src/tui`。

**占位符扫描：** 全文搜索未发现 "TBD"/"TODO"/"后续实现" 等字样；所有测试均为可运行的具体断言。

**与已批准 spec 的逐条比对（复查后修正一处）：** 对照 `docs/superpowers/specs/2026-07-31-ink-tui-design.md` 逐节重新核对，发现 Task 6 的 `ConfirmModal` 初稿只实现了 y/n 按键，遗漏了 spec 第 91 行明确要求的"方向键 + Enter"选择方式——已修正 Task 6 的测试与实现，加入 `selected` 状态、方向键切换、Enter 确认当前选中项，同时保留 y/n 快捷键。其余章节（消息区/输入框、状态栏、Todo 面板、事件契约与 depth 缩进、500 条上限、错误处理、依赖改动、测试计划）逐条核对均有对应任务覆盖，未发现其它遗漏。

**类型一致性检查：** `DisplayEntry` 的字段名（`kind`/`toolName`/`depth`/`result`/`isError`）在 Task 4/9/11 中保持一致；`AgentEvents`/`AgentEventMap` 在 Task 1/2/3/11 中签名一致；`ConfirmRequest`/`ConfirmBridge` 在 Task 5/6/11 中签名一致；`SubagentOptions`（Task 3）与 `AgentLoopOptions`（Task 2）的可选字段集合保持同构。

---

Plan complete and saved to `docs/superpowers/plans/2026-07-31-ink-tui-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
