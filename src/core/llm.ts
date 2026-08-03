import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { getAnthropicClientOptions } from "@/config.js";
import type { State } from "@/core/state.js";

let client: Anthropic | undefined;
let clientOptionsKey: string | undefined;

const ESCALATED_MAX_TOKENS = 64_000;
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
}

export async function callModelWithRecovery(
  state: State,
  options: ModelRecoveryOptions,
): Promise<Message> {
  const request = options.request ?? requestModel;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxRetries = options.maxRetries ?? MAX_TRANSIENT_RETRIES;
  let transientRetries = 0;

  while (true) {
    try {
      await options.beforeRequest?.(state);
      const response = await request({
        system: options.system,
        messages: state.messages,
        tools: options.tools,
        modelId: state.modelId,
        maxTokens: state.maxTokens,
      });
      state.consecutive529 = 0;

      if (response.stop_reason !== "max_tokens") return response;
      if (!state.hasEscalatedMaxTokens) {
        state.maxTokens = ESCALATED_MAX_TOKENS;
        state.hasEscalatedMaxTokens = true;
        continue;
      }
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

      if (statusOf(error) === 529) {
        state.consecutive529 += 1;
        if (state.consecutive529 >= 3 && options.fallbackModelId) {
          state.modelId = options.fallbackModelId;
        }
      } else {
        state.consecutive529 = 0;
      }
      const delay = retryDelay(error, transientRetries, random);
      transientRetries += 1;
      await sleep(delay);
    }
  }
}

export async function summarizeMessages(
  state: State,
  messages: MessageParam[],
): Promise<string> {
  const response = await requestModel({
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
  });
  const summary = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!summary) throw new Error("上下文摘要为空");
  return summary;
}

async function requestModel(request: ModelRequest): Promise<Message> {
  const clientOptions = getAnthropicClientOptions();
  const optionsKey = JSON.stringify(clientOptions);
  if (!client || clientOptionsKey !== optionsKey) {
    client = new Anthropic(clientOptions);
    clientOptionsKey = optionsKey;
  }

  return client.messages.create({
    model: request.modelId,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: request.messages,
    tools: request.tools,
  }, { maxRetries: 0 });
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
