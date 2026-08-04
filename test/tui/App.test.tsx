import { expect, test } from "bun:test";
import { render } from "ink-testing-library";
import { App } from "@/tui/App.js";
import { HookBus } from "@/hooks/bus.js";
import type { SkillRegistry } from "@/tools/skill.js";

const emptySkills: SkillRegistry = new Map();

function createStreamingModelServer(
  turns: Array<{
    deltas: string[];
    stopReason: "end_turn" | "tool_use";
    toolUse?: { id: string; name: string; input: unknown };
  }>,
): ReturnType<typeof Bun.serve> {
  let index = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      const turn = turns[index] ?? turns.at(-1)!;
      index += 1;
      const events: string[] = [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: `msg-${index}`,
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1, output_tokens: 0 },
          },
        })}\n\n`,
      ];

      if (turn.stopReason === "tool_use" && turn.toolUse) {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: turn.toolUse.id,
              name: turn.toolUse.name,
              input: {},
            },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(turn.toolUse.input),
            },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        );
      } else {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        for (const delta of turn.deltas) {
          events.push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta },
            })}\n\n`,
          );
        }
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        );
      }

      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: turn.stopReason, stop_sequence: null },
          usage: { output_tokens: 1 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );

      return new Response(events.join(""), {
        headers: { "content-type": "text/event-stream" },
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
  const server = createStreamingModelServer([
    { deltas: ["你好，我是助手"], stopReason: "end_turn" },
  ]);
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

test("流式 delta 逐步上屏，最终完整文本出现在渲染结果中", async () => {
  const server = createStreamingModelServer([
    { deltas: ["你好，", "我是", "助手"], stopReason: "end_turn" },
  ]);
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
    await new Promise((resolve) => setTimeout(resolve, 500));

    expect(lastFrame()).toContain("你好，我是助手");
  } finally {
    restore();
    server.stop(true);
  }
});
