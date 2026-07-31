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
