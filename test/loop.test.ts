import { expect, test } from "bun:test";
import { agentLoop, MaxStepsExceededError } from "@/core/loop.js";
import { createState } from "@/core/state.js";
import { HookBus } from "@/hooks/bus.js";

test("agent loop 回灌工具结果并受步数上限保护", async () => {
  const requests: Array<{ messages: unknown[] }> = [];
  let phase: "complete" | "limit" = "complete";
  let requestNumber = 0;
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      requestNumber += 1;
      const shouldUseTool = phase === "limit" || requestNumber === 1;
      const content = shouldUseTool
        ? [
            {
              type: "tool_use",
              id: `tool-${requestNumber}`,
              name: "bash",
              input: {
                command:
                  process.platform === "win32"
                    ? "Write-Output loop-ok"
                    : "printf loop-ok",
              },
            },
          ]
        : [{ type: "text", text: "任务完成" }];

      return Response.json({
        id: `message-${requestNumber}`,
        type: "message",
        role: "assistant",
        model: "test-model",
        content,
        stop_reason: shouldUseTool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
  const previousApiKey = process.env.API_KEY;
  const previousBaseUrl = process.env.BASE_URL;
  const previousModel = process.env.MODEL_ID;
  process.env.API_KEY = "test-key";
  process.env.BASE_URL = server.url.origin;
  process.env.MODEL_ID = "test-model";

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "执行测试" });
    await agentLoop(state);

    expect(state.steps).toBe(2);
    expect(state.messages.at(-1)).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "任务完成" }],
    });
    expect(JSON.stringify(requests[1]?.messages)).toContain("loop-ok");

    phase = "limit";
    const limitedState = createState();
    limitedState.messages.push({ role: "user", content: "持续调用工具" });
    await expect(agentLoop(limitedState, { maxSteps: 10 })).rejects.toBeInstanceOf(
      MaxStepsExceededError,
    );
    expect(limitedState.steps).toBe(10);
  } finally {
    restoreEnvironment("API_KEY", previousApiKey);
    restoreEnvironment("BASE_URL", previousBaseUrl);
    restoreEnvironment("MODEL_ID", previousModel);
    server.stop(true);
  }
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

test("PreToolUse 拒绝后回灌原因且不执行工具", async () => {
  const requests: Array<{ messages: unknown[] }> = [];
  const server = createModelServer(requests, [
    [{ type: "tool_use", id: "danger", name: "missing", input: {} }],
    [{ type: "text", text: "已改道" }],
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();
  hooks.register("PreToolUse", () => ({ action: "block", reason: "权限被拒" }));

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "执行危险操作" });
    await agentLoop(state, { hooks });

    expect(JSON.stringify(requests[1]?.messages)).toContain("权限被拒");
    expect(JSON.stringify(requests[1]?.messages)).not.toContain("未知工具");
  } finally {
    restore();
    server.stop(true);
  }
});

test("ask 经 confirm 批准后执行并合并 PostToolUse 注入", async () => {
  const requests: Array<{ messages: unknown[] }> = [];
  const command = process.platform === "win32" ? "Write-Output approved" : "printf approved";
  const server = createModelServer(requests, [
    [{ type: "tool_use", id: "ask", name: "bash", input: { command } }],
    [{ type: "text", text: "完成" }],
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();
  hooks.register("PreToolUse", () => ({ action: "ask", message: "允许吗？" }));
  hooks.register("PostToolUse", () => ({ action: "inject", context: "后置上下文" }));

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "执行" });
    await agentLoop(state, { hooks, confirm: async () => true });

    const secondRequest = JSON.stringify(requests[1]?.messages);
    expect(secondRequest).toContain("approved");
    expect(secondRequest).toContain("后置上下文");
  } finally {
    restore();
    server.stop(true);
  }
});

test("Stop respawn 只允许有限次数", async () => {
  const requests: Array<{ messages: unknown[] }> = [];
  const server = createModelServer(requests, [
    [{ type: "text", text: "第一次停止" }],
    [{ type: "text", text: "第二次停止" }],
  ]);
  const restore = useTestModel(server.url.origin);
  const hooks = new HookBus();
  hooks.register("Stop", () => ({ action: "respawn", message: "继续执行" }));

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "开始" });
    await agentLoop(state, { hooks, maxStopRespawns: 1 });

    expect(state.stopRespawnCount).toBe(1);
    expect(state.steps).toBe(2);
    expect(JSON.stringify(requests[1]?.messages)).toContain("继续执行");
  } finally {
    restore();
    server.stop(true);
  }
});

function createModelServer(
  requests: Array<{ messages: unknown[] }>,
  responses: unknown[][],
): ReturnType<typeof Bun.serve> {
  let index = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const content = responses[index++] ?? responses.at(-1) ?? [];
      const usesTool = content.some(
        (block) => typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use",
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
