import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { StatusBar } from "@/tui/components/StatusBar.js";

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
