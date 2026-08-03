import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { MessageList } from "@/tui/MessageList.js";
import type { DisplayEntry } from "@/tui/displayLog.js";

test("渲染用户、助手、系统条目", () => {
  const staticEntries: DisplayEntry[] = [
    { kind: "user", id: "e1", text: "你好" },
    { kind: "assistant", id: "e2", text: "你好，我是助手", depth: 0 },
    { kind: "system", id: "e3", text: "已达到最大步数" },
  ];
  const frame = render(
    <MessageList staticEntries={staticEntries} pendingEntries={[]} />,
  ).lastFrame();
  expect(frame).toContain("你好");
  expect(frame).toContain("你好，我是助手");
  expect(frame).toContain("已达到最大步数");
});

test("子 Agent（depth > 0）的条目带缩进标记", () => {
  const staticEntries: DisplayEntry[] = [
    { kind: "assistant", id: "e1", text: "子任务结论", depth: 1 },
  ];
  const frame = render(
    <MessageList staticEntries={staticEntries} pendingEntries={[]} />,
  ).lastFrame();
  expect(frame).toContain("↳");
  expect(frame).toContain("子任务结论");
});

test("工具条目展示状态圆点和调用摘要，不展示状态词与原始结果", () => {
  const running: DisplayEntry[] = [
    {
      kind: "tool",
      id: "t1",
      toolName: "bash",
      input: { command: "bun test" },
      depth: 0,
    },
  ];
  const runningFrame = render(
    <MessageList staticEntries={[]} pendingEntries={running} />,
  ).lastFrame();
  expect(runningFrame).toContain("● Bash(bun test)");
  expect(runningFrame).not.toContain("运行中");

  const done: DisplayEntry[] = [
    {
      kind: "tool",
      id: "t1",
      toolName: "bash",
      input: { command: "bun test" },
      depth: 0,
      result: "不应显示的原始结果",
      isError: false,
    },
  ];
  const doneFrame = render(
    <MessageList staticEntries={done} pendingEntries={[]} />,
  ).lastFrame();
  expect(doneFrame).toContain("● Bash(bun test)");
  expect(doneFrame).not.toContain("完成");
  expect(doneFrame).not.toContain("不应显示的原始结果");
});

test("子 Agent 工具条目保留缩进标记", () => {
  const entries: DisplayEntry[] = [
    {
      kind: "tool",
      id: "t1",
      toolName: "read_file",
      input: { path: "src/core/loop.ts" },
      depth: 1,
    },
  ];
  const frame = render(
    <MessageList staticEntries={[]} pendingEntries={entries} />,
  ).lastFrame();
  expect(frame).toContain("↳ ● Read(src/core/loop.ts)");
});
