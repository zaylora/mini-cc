import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import {
  isNarrowTerminal,
  WelcomePanel,
} from "@/tui/components/WelcomePanel.js";

test("展示品牌、模型、目录和空会话提示", () => {
  const { lastFrame } = render(
    <WelcomePanel workingDirectory="/workspace/project" model="claude-sonnet-5" />,
  );
  const frame = lastFrame() ?? "";

  expect(frame).toContain("mini-cc");
  expect(frame).toContain("欢迎使用");
  expect(frame).toContain("claude-sonnet-5");
  expect(frame).toContain("/workspace/project");
  expect(frame).toContain("使用提示");
  expect(frame).toContain("暂无活动");
});

test("80 列及以上使用双栏", () => {
  expect(isNarrowTerminal(79)).toBe(true);
  expect(isNarrowTerminal(80)).toBe(false);
  expect(isNarrowTerminal(undefined)).toBe(false);
});

test("长目录在面板内截断", () => {
  const workingDirectory = `/workspace/${"very-long-directory/".repeat(8)}project`;
  const { lastFrame } = render(
    <WelcomePanel workingDirectory={workingDirectory} model="claude-sonnet-5" />,
  );

  expect(lastFrame()).not.toContain(workingDirectory);
});
