import { expect, test } from "bun:test";
import { createAgentEvents } from "@/core/events.js";
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

      return createSseResponse(content, requestNumber);
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
      return createSseResponse(content, index, usesTool ? "tool_use" : "end_turn");
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

test("events 依次触发 step-start/tool-start/tool-end/todo-changed/assistant-delta", async () => {
  const requests: Array<{ messages: unknown[] }> = [];
  const server = createModelServer(requests, [
    [
      {
        type: "tool_use",
        id: "todo-1",
        name: "todo_write",
        input: { todos: [{ content: "写计划", status: "in_progress" }] },
      },
    ],
    [{ type: "text", text: "完成" }],
  ]);
  const restore = useTestModel(server.url.origin);
  const events = createAgentEvents();
  const seen: string[] = [];
  events.on("step-start", ({ step, depth }) => seen.push(`step-start:${step}:${depth}`));
  events.on("tool-start", ({ id, toolName, depth }) =>
    seen.push(`tool-start:${id}:${toolName}:${depth}`),
  );
  events.on("tool-end", ({ id, isError, depth }) =>
    seen.push(`tool-end:${id}:${isError}:${depth}`),
  );
  events.on("assistant-delta", ({ text, depth }) =>
    seen.push(`assistant-delta:${text}:${depth}`),
  );
  events.on("assistant-flush", ({ depth }) => seen.push(`assistant-flush:${depth}`));
  events.on("todo-changed", ({ todos, depth }) =>
    seen.push(`todo-changed:${todos.length}:${depth}`),
  );

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "写个计划" });
    await agentLoop(state, { events });

    expect(seen).toEqual([
      "step-start:1:0",
      "assistant-flush:0",
      "tool-start:todo-1:todo_write:0",
      "tool-end:todo-1:false:0",
      "todo-changed:1:0",
      "step-start:2:0",
      "assistant-delta:完成:0",
      "assistant-flush:0",
    ]);
  } finally {
    restore();
    server.stop(true);
  }
});

test("depth 0 时流式 delta 桥接为 assistant-delta 事件，不重复触发 assistant-message", async () => {
  const server = createModelServer([], [[{ type: "text", text: "任务完成" }]]);
  const restore = useTestModel(server.url.origin);

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "执行测试" });
    const events = createAgentEvents();
    const deltas: string[] = [];
    let flushCount = 0;
    let assistantMessageCount = 0;
    events.on("assistant-delta", ({ text }) => deltas.push(text));
    events.on("assistant-flush", () => {
      flushCount += 1;
    });
    events.on("assistant-message", () => {
      assistantMessageCount += 1;
    });

    await agentLoop(state, { events });

    expect(deltas.join("")).toBe("任务完成");
    expect(flushCount).toBeGreaterThanOrEqual(1);
    expect(assistantMessageCount).toBe(0);
  } finally {
    restore();
    server.stop(true);
  }
});

function createSseResponse(
  content: unknown[],
  index: number,
  stopReason?: "end_turn" | "tool_use",
): Response {
  const usesTool = stopReason === "tool_use" || content.some(
    (block) => typeof block === "object" && block !== null &&
      (block as { type?: string }).type === "tool_use",
  );
  const events: string[] = [
    `event: message_start\ndata: ${JSON.stringify({
      type: "message_start",
      message: {
        id: `message-${index}`,
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

  content.forEach((rawBlock, blockIndex) => {
    const block = rawBlock as {
      type: "text" | "tool_use";
      text?: string;
      id?: string;
      name?: string;
      input?: unknown;
    };
    if (block.type === "tool_use") {
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: {
            type: "tool_use",
            id: block.id,
            name: block.name,
            input: {},
          },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "input_json_delta", partial_json: JSON.stringify(block.input ?? {}) },
        })}\n\n`,
      );
    } else {
      events.push(
        `event: content_block_start\ndata: ${JSON.stringify({
          type: "content_block_start",
          index: blockIndex,
          content_block: { type: "text", text: "" },
        })}\n\n`,
        `event: content_block_delta\ndata: ${JSON.stringify({
          type: "content_block_delta",
          index: blockIndex,
          delta: { type: "text_delta", text: block.text ?? "" },
        })}\n\n`,
      );
    }
    events.push(
      `event: content_block_stop\ndata: ${JSON.stringify({
        type: "content_block_stop",
        index: blockIndex,
      })}\n\n`,
    );
  });

  events.push(
    `event: message_delta\ndata: ${JSON.stringify({
      type: "message_delta",
      delta: { stop_reason: usesTool ? "tool_use" : "end_turn", stop_sequence: null },
      usage: { output_tokens: 1 },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
  );

  return new Response(events.join(""), {
    headers: { "content-type": "text/event-stream" },
  });
}
