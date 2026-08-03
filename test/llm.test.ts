import { describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { MAX_TOKENS } from "@/config.js";
import { createState } from "@/core/state.js";
import { callModelWithRecovery } from "@/core/llm.js";

describe("callModelWithRecovery", () => {
  test("首次 max_tokens 不回灌截断内容并升到 64K 重试", async () => {
    const state = createState();
    const seenMaxTokens: number[] = [];
    const request = async ({ maxTokens }: { maxTokens: number }) => {
      seenMaxTokens.push(maxTokens);
      return seenMaxTokens.length === 1
        ? response("max_tokens", "截断内容")
        : response("end_turn", "完整内容");
    };

    const result = await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      sleep: async () => {},
    });

    expect(seenMaxTokens).toEqual([MAX_TOKENS, 64000]);
    expect(state.messages).toHaveLength(0);
    expect(JSON.stringify(result.content)).toContain("完整内容");
    expect(state.maxTokens).toBe(64000);
  });

  test("429 按 Retry-After 退避后重试", async () => {
    const state = createState();
    let attempts = 0;
    const delays: number[] = [];
    const request = async () => {
      attempts += 1;
      if (attempts === 1) throw apiError(429, "rate limit", "2");
      return response("end_turn", "完成");
    };

    await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      sleep: async (milliseconds) => { delays.push(milliseconds); },
      random: () => 0,
    });

    expect(attempts).toBe(2);
    expect(delays).toEqual([2000]);
  });

  test("连续三次 529 后切换备用模型", async () => {
    const state = createState();
    state.modelId = "primary";
    const models: string[] = [];
    const request = async ({ modelId }: { modelId: string }) => {
      models.push(modelId);
      if (models.length <= 3) throw apiError(529, "overloaded");
      return response("end_turn", "备用模型完成");
    };

    await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      fallbackModelId: "fallback",
      sleep: async () => {},
      random: () => 0,
    });

    expect(models).toEqual(["primary", "primary", "primary", "fallback"]);
    expect(state.modelId).toBe("fallback");
  });

  test("prompt_too_long 只触发一次 reactiveCompact", async () => {
    const state = createState();
    let attempts = 0;
    let compactions = 0;
    const request = async () => {
      attempts += 1;
      if (attempts === 1) throw apiError(400, "prompt is too long");
      return response("end_turn", "压缩后完成");
    };

    await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      reactiveCompact: async () => { compactions += 1; },
      sleep: async () => {},
    });

    expect(attempts).toBe(2);
    expect(compactions).toBe(1);
    expect(state.hasAttemptedReactiveCompact).toBe(true);
  });

  test("记录 API 返回的真实 input token 数", async () => {
    const state = createState();
    const request = async () => response("end_turn", "完成", 12_345);

    await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      sleep: async () => {},
    });

    expect(state.lastInputTokens).toBe(12_345);
  });
});

function response(
  stopReason: Message["stop_reason"],
  text: string,
  inputTokens = 1,
): Message {
  return {
    id: "message-test",
    type: "message",
    role: "assistant",
    model: "test-model",
    content: [{ type: "text", text, citations: null }],
    stop_reason: stopReason,
    stop_sequence: null,
    usage: {
      input_tokens: inputTokens,
      output_tokens: 1,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function apiError(status: number, message: string, retryAfter?: string): Error {
  const error = new Error(message) as Error & { status: number; headers: Headers };
  error.status = status;
  error.headers = new Headers(retryAfter ? { "retry-after": retryAfter } : undefined);
  return error;
}
