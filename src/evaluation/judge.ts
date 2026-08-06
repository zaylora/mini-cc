import Anthropic from "@anthropic-ai/sdk";
import { getAnthropicClientOptions, getModelId } from "@/config.js";
import type { JudgeResult } from "@/evaluation/types.js";
import { noopTelemetry } from "@/observability/noop.js";
import type { Telemetry } from "@/observability/types.js";

const JUDGE_SYSTEM_PROMPT = [
  "你是编码 Agent 评测裁判。",
  "只依据给定任务、目标、确定性断言摘要和 Agent 最终输出评分。",
  "必须只输出一个 JSON 对象，不要使用 Markdown 代码块或补充说明。",
  "四个维度的 score 必须是 0 到 1 之间的数字，reason 必须是简短中文理由。",
].join("\n");

let client: Anthropic | undefined;
let clientOptionsKey: string | undefined;

export interface JudgeInput {
  task: string;
  objective: string;
  assertionSummary: string;
  finalOutput: string;
}

export interface JudgeResponse {
  text: string;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
}

export interface JudgeOptions {
  telemetry?: Telemetry;
  modelId?: string;
  request?: (request: JudgeRequest) => Promise<string | JudgeResponse>;
}

export interface JudgeRequest {
  system: string;
  prompt: string;
  modelId: string;
  maxTokens: number;
}

export class JudgeError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "JudgeError";
  }
}

export async function judgeOutput(
  input: JudgeInput,
  options: JudgeOptions = {},
): Promise<JudgeResult> {
  const telemetry = options.telemetry ?? noopTelemetry;
  const modelId = options.modelId ?? getModelId();
  const request: JudgeRequest = {
    system: JUDGE_SYSTEM_PROMPT,
    prompt: buildJudgePrompt(input),
    modelId,
    maxTokens: 1_000,
  };

  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const response = await requestJudge(request, telemetry, options.request);
    try {
      return parseJudgeResult(response.text);
    } catch (error) {
      if (!(error instanceof InvalidJudgeOutputError)) throw error;
      if (attempt === 2) {
        throw new JudgeError(`Judge 连续两次返回无效结果：${error.message}`, {
          cause: error,
        });
      }
      telemetry.event("judge-retry", {
        level: "WARNING",
        statusMessage: error.message,
        metadata: { attempt },
      });
    }
  }

  throw new JudgeError("Judge 未返回结果");
}

async function requestJudge(
  request: JudgeRequest,
  telemetry: Telemetry,
  customRequest?: JudgeOptions["request"],
): Promise<JudgeResponse> {
  return telemetry.observe("anthropic-judge", {
    asType: "generation",
    input: { system: request.system, prompt: request.prompt },
    model: request.modelId,
    modelParameters: { maxTokens: request.maxTokens },
  }, async (generation) => {
    const raw = customRequest
      ? await customRequest(request)
      : await defaultJudgeRequest(request);
    const response = typeof raw === "string" ? { text: raw } : raw;
    const inputTokens = response.inputTokens;
    const outputTokens = response.outputTokens;
    generation.update({
      output: response.text,
      model: response.model ?? request.modelId,
      usageDetails: inputTokens !== undefined && outputTokens !== undefined
        ? {
          input: inputTokens,
          output: outputTokens,
          total: inputTokens + outputTokens,
        }
        : undefined,
    });
    return response;
  });
}

async function defaultJudgeRequest(request: JudgeRequest): Promise<JudgeResponse> {
  const clientOptions = getAnthropicClientOptions();
  const optionsKey = JSON.stringify(clientOptions);
  if (!client || clientOptionsKey !== optionsKey) {
    client = new Anthropic(clientOptions);
    clientOptionsKey = optionsKey;
  }

  const response = await client.messages.create({
    model: request.modelId,
    max_tokens: request.maxTokens,
    system: request.system,
    messages: [{ role: "user", content: request.prompt }],
  }, { maxRetries: 0 });
  const text = response.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n")
    .trim();
  if (!text) throw new JudgeError("Judge 返回了空文本");
  return {
    text,
    model: response.model,
    inputTokens: response.usage.input_tokens,
    outputTokens: response.usage.output_tokens,
  };
}

function buildJudgePrompt(input: JudgeInput): string {
  return [
    "请按以下固定 JSON 结构评分：",
    '{"accuracy":{"score":0,"reason":""},"relevance":{"score":0,"reason":""},"completeness":{"score":0,"reason":""},"creativity":{"score":0,"reason":""}}',
    "",
    `任务：${input.task}`,
    `目标：${input.objective}`,
    `确定性断言：${input.assertionSummary}`,
    `Agent 最终输出：${input.finalOutput}`,
  ].join("\n");
}

function parseJudgeResult(text: string): JudgeResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new InvalidJudgeOutputError("不是合法 JSON", { cause: error });
  }
  if (!isPlainObject(parsed)) {
    throw new InvalidJudgeOutputError("根节点必须是对象");
  }

  const dimensions = [
    "accuracy",
    "relevance",
    "completeness",
    "creativity",
  ] as const;
  if (!hasExactKeys(parsed, dimensions)) {
    throw new InvalidJudgeOutputError("必须且只能包含四个评分维度");
  }

  const result = {} as JudgeResult;
  for (const dimension of dimensions) {
    const value = parsed[dimension];
    if (!isPlainObject(value) || !hasExactKeys(value, ["score", "reason"])) {
      throw new InvalidJudgeOutputError(`${dimension} 结构无效`);
    }
    if (
      typeof value.score !== "number" ||
      !Number.isFinite(value.score) ||
      value.score < 0 ||
      value.score > 1
    ) {
      throw new InvalidJudgeOutputError(`${dimension}.score 必须在 0 到 1 之间`);
    }
    if (typeof value.reason !== "string" || !value.reason.trim()) {
      throw new InvalidJudgeOutputError(`${dimension}.reason 不能为空`);
    }
    result[dimension] = { score: value.score, reason: value.reason.trim() };
  }
  return result;
}

class InvalidJudgeOutputError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidJudgeOutputError";
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}
