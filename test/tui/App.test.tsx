import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "@/tui/App.js";
import { HookBus } from "@/hooks/bus.js";
import { noopTelemetry } from "@/observability/noop.js";
import type { SkillRegistry } from "@/tools/skill.js";
import {
  createStreamingModelServer,
  flush,
  useTestModel,
  waitFor,
} from "./modelServer.js";

const emptySkills: SkillRegistry = new Map();

test("空会话显示欢迎面板", async () => {
  const { lastFrame } = render(
    <App
      workingDirectory="/tmp"
      hooks={new HookBus()}
      skills={emptySkills}
      telemetry={noopTelemetry}
    />,
  );
  await flush();

  expect(lastFrame()).toContain("欢迎使用 mini-cc");
  expect(lastFrame()).toContain("暂无活动");
});

test("提交问题后渲染用户输入与模型回复", async () => {
  const server = createStreamingModelServer([
    { deltas: ["你好，我是助手"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();

  try {
    const { stdin, lastFrame } = render(
      <App
        workingDirectory="/tmp"
        hooks={hooks}
        skills={emptySkills}
        telemetry={noopTelemetry}
      />,
    );
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await flush();

    expect(lastFrame()).toContain("你好");
    expect(lastFrame()).toContain("你好，我是助手");
    expect(lastFrame()).toContain("context 1 / 200,000 tokens");
    expect(lastFrame()).not.toContain("欢迎使用 mini-cc");
  } finally {
    restore();
    server.stop(true);
  }
});

test("PreToolUse 请求确认时展示 ConfirmModal，批准后继续执行并关闭弹层", async () => {
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

  try {
    const { stdin, lastFrame } = render(
      <App
        workingDirectory="/tmp"
        hooks={hooks}
        skills={emptySkills}
        telemetry={noopTelemetry}
      />,
    );
    await flush();
    stdin.write("跑一下");
    await flush();
    stdin.write("\r");
    await flush();
    expect(lastFrame()).toContain("允许执行 bash 吗？");

    stdin.write("y");
    await waitFor(() => lastFrame()?.includes("执行完成") === true);

    expect(lastFrame()).toContain("执行完成");
    expect(lastFrame()).not.toContain("允许执行 bash 吗？");
  } finally {
    restore();
    server.stop(true);
  }
});

test("流式 delta 逐步上屏，最终完整文本出现在渲染结果中", async () => {
  const server = createStreamingModelServer([
    { deltas: ["你好，", "我是", "助手"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();

  try {
    const { stdin, lastFrame } = render(
      <App
        workingDirectory="/tmp"
        hooks={hooks}
        skills={emptySkills}
        telemetry={noopTelemetry}
      />,
    );
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(lastFrame()).toContain("你好，我是助手");
  } finally {
    restore();
    server.stop(true);
  }
});
