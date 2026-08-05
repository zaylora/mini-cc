import { describe, expect, test } from "bun:test";
import type { Message } from "@anthropic-ai/sdk/resources/messages/messages";
import { createState } from "@/core/state.js";
import { callModelWithRecovery } from "@/core/llm.js";

describe("callModelWithRecovery", () => {
  test("首个 max_tokens 直接落入 continuation 续写，不重发", async () => {
    const state = createState();
    const seenMaxTokens: number[] = [];
    let requestCount = 0;
    const request = async ({ maxTokens }: { maxTokens: number }) => {
      seenMaxTokens.push(maxTokens);
      requestCount += 1;
      return requestCount === 1
        ? response("max_tokens", "截断内容")
        : response("end_turn", "续写内容");
    };

    const result = await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      sleep: async () => {},
    });

    expect(seenMaxTokens).toEqual([state.maxTokens, state.maxTokens]);
    expect(JSON.stringify(state.messages)).toContain("截断内容");
    expect(JSON.stringify(result.content)).toContain("续写内容");
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

  test("瞬时错误重试前通知流式中断", async () => {
    const state = createState();
    const interruptions: string[] = [];
    let attempts = 0;
    const request = async () => {
      attempts += 1;
      if (attempts === 1) {
        const error = new Error("connection lost");
        error.name = "APIConnectionError";
        throw error;
      }
      return response("end_turn", "重试完成");
    };

    await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      sleep: async () => {},
      onStreamInterrupted: (reason) => interruptions.push(reason),
    });

    expect(interruptions).toEqual(["connection lost"]);
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

  test("连续三次 529 切换 fallback 模型后，maxTokens 按新模型重新查表", async () => {
    const state = createState();
    state.modelId = "claude-sonnet-5";
    const seenMaxTokens: number[] = [];
    let attempts = 0;
    const request = async ({ maxTokens }: { modelId: string; maxTokens: number }) => {
      attempts += 1;
      seenMaxTokens.push(maxTokens);
      if (attempts <= 3) throw apiError(529, "overloaded");
      return response("end_turn", "备用模型完成");
    };

    await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      fallbackModelId: "claude-haiku-4-5",
      sleep: async () => {},
      random: () => 0,
    });

    expect(state.modelId).toBe("claude-haiku-4-5");
    expect(state.maxTokens).toBe(64_000);
    expect(seenMaxTokens.at(-1)).toBe(64_000);
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

  test("callModelWithRecovery 通过 onTextDelta 转发流式增量文本", async () => {
    const state = createState();
    const deltas: string[] = [];
    let flushCount = 0;
    const request = async () => response("end_turn", "完整回复");

    await callModelWithRecovery(state, {
      system: "system",
      tools: [],
      request,
      sleep: async () => {},
      onTextDelta: (text) => deltas.push(text),
      onStreamFlush: () => {
        flushCount += 1;
      },
    });

    expect(flushCount).toBeGreaterThanOrEqual(0);
  });

  test("不传 request 选项时，requestModel 使用流式 API 并通过回调转发文本", async () => {
    const previousApiKey = process.env.API_KEY;
    const previousBaseUrl = process.env.BASE_URL;
    process.env.API_KEY = "test-key";

    const sseBody = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":5,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hello "}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":2}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ].join("");

    const server = Bun.serve({
      port: 0,
      fetch() {
        return new Response(sseBody, {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    process.env.BASE_URL = server.url.origin;

    try {
      const state = createState();
      state.modelId = "test-model";
      const deltas: string[] = [];
      let flushed = false;

      const result = await callModelWithRecovery(state, {
        system: "system",
        tools: [],
        sleep: async () => {},
        onTextDelta: (text) => deltas.push(text),
        onStreamFlush: () => {
          flushed = true;
        },
      });

      expect(deltas.join("")).toBe("hello world");
      expect(flushed).toBe(true);
      expect(result.stop_reason).toBe("end_turn");
      expect(JSON.stringify(result.content)).toContain("hello world");
    } finally {
      server.stop(true);
      if (previousApiKey === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previousBaseUrl;
    }
  });

  test("流在最终消息前结束时仍刷新已收到的 delta", async () => {
    const previousApiKey = process.env.API_KEY;
    const previousBaseUrl = process.env.BASE_URL;
    process.env.API_KEY = "test-key";

    const incompleteSse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_partial","type":"message","role":"assistant","model":"test-model","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":1,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"半截内容"}}\n\n',
    ].join("");
    const server = Bun.serve({
      port: 0,
      fetch: () => new Response(incompleteSse, {
        headers: { "content-type": "text/event-stream" },
      }),
    });
    process.env.BASE_URL = server.url.origin;

    try {
      const state = createState();
      state.modelId = "test-model";
      const deltas: string[] = [];
      let flushCount = 0;

      await expect(callModelWithRecovery(state, {
        system: "system",
        tools: [],
        maxRetries: 0,
        onTextDelta: (text) => deltas.push(text),
        onStreamFlush: () => {
          flushCount += 1;
        },
      })).rejects.toThrow();

      expect(deltas).toEqual(["半截内容"]);
      expect(flushCount).toBe(1);
    } finally {
      server.stop(true);
      if (previousApiKey === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = previousApiKey;
      if (previousBaseUrl === undefined) delete process.env.BASE_URL;
      else process.env.BASE_URL = previousBaseUrl;
    }
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
