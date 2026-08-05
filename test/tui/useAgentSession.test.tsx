import { expect, test } from "bun:test";
import { Text } from "ink";
import { render } from "ink-testing-library";
import { HookBus } from "@/hooks/bus.js";
import {
  useAgentSession,
  type AgentSession,
} from "@/tui/hooks/useAgentSession.js";
import type { SkillRegistry } from "@/tools/skill.js";
import {
  createStreamingModelServer,
  flush,
  useTestModel,
  waitFor,
} from "./modelServer.js";

const emptySkills: SkillRegistry = new Map();
let latestSession: AgentSession | undefined;

function SessionHarness({ hooks }: { hooks: HookBus }): JSX.Element {
  const session = useAgentSession({ hooks, skills: emptySkills });
  latestSession = session;
  return <Text>{session.busy ? "busy" : "idle"}</Text>;
}

test("提供空闲的初始会话状态和会话命令", () => {
  const view = render(<SessionHarness hooks={new HookBus()} />);

  expect(view.lastFrame()).toBe("idle");
  expect(latestSession?.displayLog.staticEntries).toEqual([]);
  expect(latestSession?.displayLog.pendingEntries).toEqual([]);
  expect(latestSession?.todos).toEqual([]);
  expect(latestSession?.step).toBe(0);
  expect(latestSession?.pendingConfirm).toBeUndefined();
  expect(typeof latestSession?.submit).toBe("function");
  expect(typeof latestSession?.resolveConfirm).toBe("function");

  view.unmount();
});

test("提交问题后记录用户输入和模型回复", async () => {
  const server = createStreamingModelServer([
    { deltas: ["你好，我是助手"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const view = render(<SessionHarness hooks={new HookBus()} />);

  try {
    await flush();
    await latestSession!.submit("你好");
    await flush(50);

    expect(latestSession!.busy).toBe(false);
    expect(latestSession!.displayLog.staticEntries).toMatchObject([
      { kind: "user", text: "你好" },
      { kind: "assistant-block", block: { kind: "paragraph" } },
    ]);
  } finally {
    view.unmount();
    restore();
    server.stop(true);
  }
});

test("多步任务在每次模型响应后立即刷新 input token", async () => {
  let releaseSecondTurn = (): void => {};
  const waitForSecondTurn = new Promise<void>((resolve) => {
    releaseSecondTurn = resolve;
  });
  const server = createStreamingModelServer([
    {
      deltas: [],
      stopReason: "tool_use",
      toolUse: {
        id: "todo-1",
        name: "todo_write",
        input: { todos: [{ content: "继续执行", status: "in_progress" }] },
      },
      inputTokens: 123,
    },
    {
      deltas: ["执行完成"],
      stopReason: "end_turn",
      inputTokens: 456,
      waitFor: waitForSecondTurn,
    },
  ]);
  const restore = useTestModel(server.url.origin);
  const view = render(<SessionHarness hooks={new HookBus()} />);

  try {
    await flush();
    const submission = latestSession!.submit("执行多步任务");
    await waitFor(() => latestSession?.step === 2);

    expect(latestSession!.busy).toBe(true);
    expect(latestSession!.inputTokens).toBe(123);

    releaseSecondTurn();
    await submission;
    await flush(50);
    expect(latestSession!.inputTokens).toBe(456);
  } finally {
    releaseSecondTurn();
    view.unmount();
    restore();
    server.stop(true);
  }
});

test("子 Agent 的 todo 不覆盖主 Agent 的 TodoPanel 状态", async () => {
  const server = createStreamingModelServer([
    {
      deltas: [],
      stopReason: "tool_use",
      toolUse: {
        id: "main-todo",
        name: "todo_write",
        input: { todos: [{ content: "主任务", status: "in_progress" }] },
      },
    },
    {
      deltas: [],
      stopReason: "tool_use",
      toolUse: { id: "task-1", name: "task", input: { description: "执行子任务" } },
    },
    {
      deltas: [],
      stopReason: "tool_use",
      toolUse: {
        id: "child-todo",
        name: "todo_write",
        input: { todos: [{ content: "子任务", status: "in_progress" }] },
      },
    },
    { deltas: ["子任务完成"], stopReason: "end_turn" },
    { deltas: ["全部完成"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const view = render(<SessionHarness hooks={new HookBus()} />);

  try {
    await flush();
    await latestSession!.submit("执行主任务");
    await flush(50);

    expect(latestSession!.todos).toEqual([
      { content: "主任务", status: "in_progress" },
    ]);
  } finally {
    view.unmount();
    restore();
    server.stop(true);
  }
});

test("确认请求获准后继续执行并清空 pendingConfirm", async () => {
  const command = process.platform === "win32" ? "Write-Output ok" : "printf ok";
  const server = createStreamingModelServer([
    {
      deltas: [],
      stopReason: "tool_use",
      toolUse: { id: "ask-1", name: "bash", input: { command } },
    },
    { deltas: ["执行完成"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();
  hooks.register("PreToolUse", () => ({ action: "ask", message: "允许执行 bash 吗？" }));
  const view = render(<SessionHarness hooks={hooks} />);

  try {
    await flush();
    const submission = latestSession!.submit("跑一下");
    await waitFor(() => latestSession?.pendingConfirm !== undefined);
    expect(latestSession!.pendingConfirm?.message).toBe("允许执行 bash 吗？");

    latestSession!.resolveConfirm(true);
    await submission;
    await flush(50);

    expect(latestSession!.pendingConfirm).toBeUndefined();
    expect(latestSession!.displayLog.staticEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: "assistant-block" }),
      ]),
    );
  } finally {
    view.unmount();
    restore();
    server.stop(true);
  }
});

test("模型请求失败时追加 system 日志并恢复空闲状态", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json(
        {
          type: "error",
          error: { type: "invalid_request_error", message: "测试请求失败" },
        },
        {
          status: 400,
        },
      ),
  });
  const restore = useTestModel(server.url.origin);
  const view = render(<SessionHarness hooks={new HookBus()} />);

  try {
    await flush();
    await latestSession!.submit("触发错误");
    await flush(50);

    expect(latestSession!.busy).toBe(false);
    expect(latestSession!.displayLog.staticEntries.at(-1)).toMatchObject({
      kind: "system",
    });
  } finally {
    view.unmount();
    restore();
    server.stop(true);
  }
});
