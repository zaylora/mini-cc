# TUI 工程化重构设计

## 背景

当前 `src/tui` 的组件、纯状态逻辑和异步桥接文件平铺在同一目录。`App.tsx` 同时负责 Agent 生命周期、事件订阅、流式 Markdown 调度、确认请求、错误展示和视图组合，导致运行逻辑与 Ink 组件耦合。

本次重构只调整 TUI 内部架构，保持现有界面、CLI 入口、Agent 行为和事件协议不变。

## 目标

- 按视图、运行控制、纯状态逻辑和服务桥接划分目录。
- 将 Agent 运行和事件订阅从 `App.tsx` 提取到 React hook。
- 保持纯逻辑可独立测试，保留现有 TUI 集成测试。
- 业务源码改动限制在 `src/tui`。

## 非目标

- 不修改 `src/core`、`src/cli`、`src/markdown` 或 `src/tools`。
- 不改变界面文案、布局、交互方式或流式刷新频率。
- 不引入 Context、reducer、第三方状态管理库或新的配置项。
- 不增加 barrel export 或为未来功能预留抽象。

## 目录结构

```text
src/tui/
|-- App.tsx
|-- components/
|   |-- ConfirmModal.tsx
|   |-- InputBox.tsx
|   |-- Markdown.tsx
|   |-- MessageList.tsx
|   |-- StatusBar.tsx
|   `-- TodoPanel.tsx
|-- hooks/
|   `-- useAgentSession.ts
|-- model/
|   |-- displayLog.ts
|   |-- streamBuffer.ts
|   `-- toolCallFormat.ts
`-- services/
    `-- confirmBridge.ts
```

### 组件层

`components` 中的文件只根据 props 渲染 Ink 视图。组件可以依赖 `model` 中的数据类型和纯格式化函数，但不能调用 `agentLoop`、注册 Agent 事件或持有运行时对象。

### 会话控制层

`hooks/useAgentSession.ts` 是 TUI 与 Agent runtime 的唯一连接点，负责：

- 创建并持有 `State`、`AgentEvents`、`ConfirmBridge` 和流式缓冲区。
- 注册 Agent 事件并转换为 TUI 状态。
- 执行 `UserPromptSubmit` hook 和 `agentLoop`。
- 管理 `displayLog`、`todos`、`step`、`busy` 和待确认请求。
- 处理流式刷新定时器，并在卸载时清理。
- 将运行异常转换成现有 system 日志。

该 hook 返回以下稳定接口：

```ts
interface AgentSession {
  displayLog: DisplayLog;
  todos: Todo[];
  step: number;
  busy: boolean;
  pendingConfirm?: ConfirmRequest;
  submit(text: string): Promise<void>;
  resolveConfirm(allowed: boolean): void;
}
```

### 模型层

`model` 保留不依赖 React 和 Ink 的数据结构及纯函数：

- `displayLog.ts`：管理静态、待完成和流式展示条目。
- `streamBuffer.ts`：把增量文本拆分为已提交 Markdown 块和流式尾部。
- `toolCallFormat.ts`：生成工具名称、摘要和状态颜色。

### 服务层

`services/confirmBridge.ts` 保留 Promise 与 UI 确认请求之间的桥接，不感知 React 组件。

## 数据流

```text
用户输入
  -> App
  -> useAgentSession.submit
  -> UserPromptSubmit Hook
  -> agentLoop
  -> AgentEvents
  -> useAgentSession 更新 TUI 状态
  -> App 将状态传给 components
```

`App.tsx` 仅保留输入框文本状态和组件组合。空输入与忙碌状态仍由 `submit` 拦截；确认结果通过 `resolveConfirm` 返回给 `ConfirmBridge`。

## 错误与生命周期

- `MaxStepsExceededError` 和其他异常继续使用当前消息转换规则写入 system 日志。
- `assistant-flush` 和 `stream-interrupted` 继续提交缓冲区并停止刷新定时器。
- hook 卸载时清除尚未结束的定时器，避免测试或 CLI 退出后残留任务。
- 不扩展现有错误分类或用户提示。

## 测试策略

- 保持 `test/tui` 的现有目录布局，只更新源码移动后的 import。
- 新增 `test/tui/useAgentSession.test.tsx`，覆盖提交、运行状态、确认响应和异常日志。
- 保留 `App` 集成测试，继续覆盖用户输入、模型回复、确认弹窗和流式输出。
- 不改变 `src/tui` 以外测试所验证的公共契约。

## 验收标准

- `src/tui` 符合设计中的目录结构和依赖方向。
- `App.tsx` 不再直接创建 Agent runtime 对象、注册 Agent 事件或管理流式缓冲区。
- 用户可见行为与重构前一致。
- `bun test test/tui` 通过。
- `bun run typecheck` 通过。
- `bun run build` 通过。
- `git diff --check` 通过。
