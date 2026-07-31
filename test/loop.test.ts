import { expect, test } from "bun:test";
import { agentLoop, MaxStepsExceededError } from "@/core/loop.js";
import { createState } from "@/core/state.js";

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
    await expect(agentLoop(limitedState)).rejects.toBeInstanceOf(
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
