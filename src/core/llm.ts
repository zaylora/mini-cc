import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { getAnthropicClientOptions } from "@/config.js";
import { maxOutputTokensFor } from "@/core/modelLimits.js";
import type { State } from "@/core/state.js";
import { noopTelemetry } from "@/observability/noop.js";
import type { Telemetry } from "@/observability/types.js";

let client: Anthropic | undefined;
let clientOptionsKey: string | undefined;

const MAX_TRANSIENT_RETRIES = 10;
const MAX_CONTINUATIONS = 3;
const CONTINUATION_PROMPT =
  "Output token limit hit. Resume directly - no apology, no recap. Pick up mid-thought and break remaining work into smaller pieces.";

export interface ModelRequest {
  system: string;
  messages: MessageParam[];
  tools: Tool[];
  modelId: string;
  maxTokens: number;
}

export interface ModelRecoveryOptions {
  system: string;
  tools: Tool[];
  request?: (request: ModelRequest) => Promise<Message>;
  beforeRequest?: (state: State) => Promise<void>;
  reactiveCompact?: (state: State) => Promise<void>;
  fallbackModelId?: string;
  sleep?: (milliseconds: number) => Promise<void>;
  random?: () => number;
  maxRetries?: number;
  telemetry?: Telemetry;
  onTextDelta?: (text: string) => void;
  onStreamFlush?: () => void;
  onStreamInterrupted?: (reason: string) => void;
}

export async function callModelWithRecovery(
  state: State,
  options: ModelRecoveryOptions,
): Promise<Message> {
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxRetries = options.maxRetries ?? MAX_TRANSIENT_RETRIES;
  const telemetry = options.telemetry ?? noopTelemetry;
  let transientRetries = 0;

  while (true) {
    let attemptedModelId = state.modelId;
    try {
      await options.beforeRequest?.(state);
      attemptedModelId = state.modelId;
      const response = await observeModelAttempt(state, telemetry, {
        system: options.system,
        messages: state.messages,
        tools: options.tools,
        modelId: state.modelId,
        maxTokens: state.maxTokens,
      }, {
        request: options.request,
        onTextDelta: options.onTextDelta,
        onStreamFlush: options.onStreamFlush,
      });
      state.consecutive529 = 0;
      state.lastInputTokens = response.usage.input_tokens;

      if (response.stop_reason !== "max_tokens") return response;
      if (state.recoveryCount >= MAX_CONTINUATIONS) return response;

      state.messages.push({ role: "assistant", content: response.content });
      state.messages.push({ role: "user", content: CONTINUATION_PROMPT });
      state.recoveryCount += 1;
    } catch (error) {
      if (isPromptTooLongError(error)) {
        if (
          state.hasAttemptedReactiveCompact ||
          options.reactiveCompact === undefined
        ) {
          throw error;
        }
        await options.reactiveCompact(state);
        state.hasAttemptedReactiveCompact = true;
        continue;
      }
      if (!isTransientError(error) || transientRetries >= maxRetries) throw error;

      options.onStreamInterrupted?.(errorMessage(error));
      if (statusOf(error) === 529) {
        state.consecutive529 += 1;
        if (
          state.consecutive529 >= 3 &&
          options.fallbackModelId &&
          state.modelId !== options.fallbackModelId
        ) {
          state.modelId = options.fallbackModelId;
          state.maxTokens = maxOutputTokensFor(state.modelId);
          telemetry.event("model-fallback", {
            level: "WARNING",
            statusMessage: errorMessage(error),
            metadata: {
              fromModelId: attemptedModelId,
              toModelId: state.modelId,
            },
          });
        }
      } else {
        state.consecutive529 = 0;
      }
      const delay = retryDelay(error, transientRetries, random);
      transientRetries += 1;
      state.metrics.retries += 1;
      telemetry.event("model-retry", {
        level: "WARNING",
        statusMessage: errorMessage(error),
        metadata: {
          attempt: transientRetries,
          delayMs: delay,
          modelId: attemptedModelId,
          status: statusOf(error),
        },
      });
      await sleep(delay);
    }
  }
}

export async function summarizeMessages(
  state: State,
  messages: MessageParam[],
  telemetry: Telemetry = noopTelemetry,
): Promise<string> {
  const response = await observeModelAttempt(state, telemetry, {
    system: "只输出文本摘要，不要调用工具。",
    messages: [{
      role: "user",
      content: [
        "请总结这段编码 Agent 对话，使工作可以继续。",
        "保留：当前目标、关键发现与决策、已读取或修改的文件、剩余工作、用户约束。",
        "摘要要紧凑、具体，不要调用工具。",
        "",
        JSON.stringify(messages).slice(0, 320_000),
      ].join("\n"),
    }],
    tools: [],
    modelId: state.modelId,
    maxTokens: 2_000,
  }, {});
  const summary = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!summary) throw new Error("上下文摘要为空");
  return summary;
}

interface ModelAttemptOptions {
  request?: (request: ModelRequest) => Promise<Message>;
  onTextDelta?: (text: string) => void;
  onStreamFlush?: () => void;
}

async function observeModelAttempt(
  state: State,
  telemetry: Telemetry,
  request: ModelRequest,
  options: ModelAttemptOptions,
): Promise<Message> {
  const startedAt = performance.now();
  let completionStartTime: Date | undefined;
  state.metrics.modelCalls += 1;

  return telemetry.observe("anthropic-generation", {
    asType: "generation",
    input: {
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    },
    model: request.modelId,
    modelParameters: { maxTokens: request.maxTokens },
  }, async (generation) => {
    try {
      const response = options.request
        ? await options.request(request)
        : await requestModel(
          request,
          (text) => {
            if (!completionStartTime) {
              completionStartTime = new Date();
              state.metrics.firstTokenLatenciesMs.push(
                Math.max(0, performance.now() - startedAt),
              );
              generation.update({ completionStartTime });
            }
            options.onTextDelta?.(text);
          },
          options.onStreamFlush,
        );
      const inputTokens = response.usage.input_tokens;
      const outputTokens = response.usage.output_tokens;
      state.metrics.inputTokens += inputTokens;
      state.metrics.outputTokens += outputTokens;
      generation.update({
        output: response.content,
        model: response.model || request.modelId,
        usageDetails: {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        },
        completionStartTime,
        metadata: {
          messageId: response.id,
          stopReason: response.stop_reason,
        },
      });
      return response;
    } catch (error) {
      generation.update({
        level: "ERROR",
        statusMessage: errorMessage(error),
      });
      throw error;
    } finally {
      const durationMs = Math.max(0, performance.now() - startedAt);
      state.metrics.modelDurationMs += durationMs;
      generation.update({ metadata: { durationMs } });
    }
  });
}

async function requestModel(
  request: ModelRequest,
  onTextDelta?: (text: string) => void,
  onStreamFlush?: () => void,
): Promise<Message> {
  const clientOptions = getAnthropicClientOptions();
  const optionsKey = JSON.stringify(clientOptions);
  if (!client || clientOptionsKey !== optionsKey) {
    client = new Anthropic(clientOptions);
    clientOptionsKey = optionsKey;
  }

  const stream = client.messages.stream(
    {
      model: request.modelId,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages,
      tools: request.tools,
    },
    { maxRetries: 0 },
  );

  if (onTextDelta) {
    stream.on("text", (delta) => onTextDelta(delta));
  }

  try {
    return await stream.finalMessage();
  } finally {
    onStreamFlush?.();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isPromptTooLongError(error: unknown): boolean {
  const text = error instanceof Error
    ? `${error.name} ${error.message} ${JSON.stringify(error)}`
    : String(error);
  return /prompt(?:[_ ]is)?[_ ]too[_ ]long|context.*too (?:long|large)|request_too_large/i.test(text);
}

function isTransientError(error: unknown): boolean {
  const status = statusOf(error);
  if (status === 429 || status === 529) return true;
  const name = error instanceof Error ? error.name : "";
  return error instanceof Anthropic.APIConnectionError ||
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError";
}

function statusOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("status" in error)) return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

function retryDelay(
  error: unknown,
  attempt: number,
  random: () => number,
): number {
  const retryAfter = retryAfterMilliseconds(error);
  if (retryAfter !== undefined) return retryAfter;
  const base = Math.min(500 * 2 ** attempt, 32_000);
  return base + Math.floor(random() * base * 0.25);
}

function retryAfterMilliseconds(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("headers" in error)) return undefined;
  const headers = (error as { headers?: unknown }).headers;
  if (!(headers instanceof Headers)) return undefined;
  const value = headers.get("retry-after");
  if (!value) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : undefined;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
