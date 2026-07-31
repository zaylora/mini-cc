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
  return new Promise((resolve) => setTimeout(resolve, 350));
}

test("提交问题后渲染用户输入与模型回复", async () => {
  const server = createModelServer([[{ type: "text", text: "你好，我是助手" }]]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();

  try {
    const { stdin, lastFrame } = render(
      <App workingDirectory="/tmp" hooks={hooks} skills={emptySkills} />,
    );
    await flush();
    stdin.write("你好");
    await flush();
    stdin.write("\r");
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
    await flush();
    stdin.write("跑一下");
    await flush();
    stdin.write("\r");
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
