import type {
  Evaluation,
  ExperimentTaskParams,
  FetchedDataset,
} from "@langfuse/client";
import { createDefaultHookBus } from "@/hooks/index.js";
import { agentLoop, type AgentLoopOptions } from "@/core/loop.js";
import { createState, type AgentMetrics, type State } from "@/core/state.js";
import { evaluateAssertions } from "@/evaluation/assertions.js";
import { judgeOutput, type JudgeInput } from "@/evaluation/judge.js";
import {
  aggregateRuns,
  type AggregateMetrics,
  type MetricRun,
} from "@/evaluation/metrics.js";
import type {
  AssertionResult,
  AssertionSpec,
  JudgeResult,
} from "@/evaluation/types.js";
import { createEvalWorkspace } from "@/evaluation/workspace.js";
import type { Telemetry } from "@/observability/types.js";
import type { SkillRegistry } from "@/tools/skill.js";

const REPEAT_COUNT = 3;

export interface EvalRunResult extends MetricRun {
  caseId: string;
  repeat: number;
  finalOutput: string;
  assertionResults: AssertionResult[];
  metrics: AgentMetrics;
  judge?: JudgeResult;
  judgeError?: string;
  error?: string;
}

export interface EvalItemOutput {
  caseId: string;
  name: string;
  runs: EvalRunResult[];
  aggregate: AggregateMetrics;
}

export interface EvaluationDependencies {
  telemetry: Telemetry;
  onProgress?: (message: string) => void;
  runAgent?: (state: State, options: AgentLoopOptions) => Promise<void>;
  judge?: typeof judgeOutput;
  createWorkspace?: typeof createEvalWorkspace;
  skills?: SkillRegistry;
  judgeModelId?: string;
}

export interface ExperimentOptions {
  runName: string;
  gitCommit: string;
  modelId: string;
  judgeModelId: string;
}

export function runEvaluationExperiment(
  dataset: FetchedDataset,
  dependencies: EvaluationDependencies,
  options: ExperimentOptions,
) {
  const nextDependencies = {
    ...dependencies,
    judgeModelId: options.judgeModelId,
  };
  return dataset.runExperiment({
    name: "mini-cc-core-eval",
    runName: options.runName,
    description: "mini-cc 编码 Agent 核心能力回归评测",
    metadata: {
      gitCommit: options.gitCommit,
      modelId: options.modelId,
      judgeModelId: options.judgeModelId,
      repeatCount: REPEAT_COUNT,
      rubricVersion: 2,
    },
    maxConcurrency: 1,
    task: (item) => runEvalItem(item, nextDependencies),
    evaluators: [createItemEvaluator()],
    runEvaluators: [createRunEvaluator()],
  });
}

export async function runEvalItem(
  item: ExperimentTaskParams,
  dependencies: EvaluationDependencies,
): Promise<EvalItemOutput> {
  const parsed = parseDatasetItem(item);
  const runAgent = dependencies.runAgent ?? agentLoop;
  const judge = dependencies.judge ?? judgeOutput;
  const createWorkspace = dependencies.createWorkspace ?? createEvalWorkspace;
  const runs: EvalRunResult[] = [];
  const progress = dependencies.onProgress ?? (() => {});

  progress(`[${parsed.caseId}] 开始评测：${parsed.name}`);

  for (let repeat = 1; repeat <= REPEAT_COUNT; repeat += 1) {
    progress(`[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：创建工作区`);
    const workspace = await createWorkspace(parsed.files);
    progress(`[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：工作区已就绪`);
    const originalCwd = process.cwd();
    try {
      process.chdir(workspace.path);
      const state = createState();
      state.messages.push({ role: "user", content: parsed.prompt });
      let agentError: string | undefined;
      const startedAt = performance.now();
      progress(`[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：Agent 开始运行`);
      try {
        await runAgent(state, {
          hooks: createDefaultHookBus(),
          skills: dependencies.skills,
          telemetry: dependencies.telemetry,
        });
      } catch (error) {
        agentError = errorMessage(error);
      }
      const durationMs = Math.max(0, performance.now() - startedAt);
      progress(agentError
        ? `[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：Agent 运行失败：${agentError}`
        : `[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：Agent 运行完成（${Math.round(durationMs)}ms）`);
      const finalOutput = latestAssistantText(state);
      progress(`[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：开始执行确定性断言`);
      const assertionResults = await evaluateAssertions(workspace.path, {
        finalOutput,
        todos: state.todos,
      }, parsed.assertions);
      const passedAssertions = assertionResults.filter((result) => result.passed).length;
      progress(
        `[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：确定性断言完成（${passedAssertions}/${assertionResults.length} 通过）`,
      );
      const success = agentError === undefined &&
        assertionResults.every((result) => result.passed);
      let judgeResult: JudgeResult | undefined;
      let judgeError: string | undefined;
      try {
        const judgeInput: JudgeInput = {
          task: parsed.prompt,
          objective: parsed.objective,
          assertionSummary: formatAssertionSummary(assertionResults),
          finalOutput,
        };
        progress(`[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：Judge 开始评分`);
        judgeResult = await judge(judgeInput, {
          telemetry: dependencies.telemetry,
          modelId: dependencies.judgeModelId,
        });
      } catch (error) {
        judgeError = errorMessage(error);
      }
      progress(judgeError
        ? `[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：Judge 评分失败：${judgeError}`
        : `[${parsed.caseId}] 第 ${repeat}/${REPEAT_COUNT} 轮：Judge 评分完成`);

      runs.push({
        caseId: parsed.caseId,
        repeat,
        success,
        quality: judgeResult ? judgeQuality(judgeResult) : undefined,
        durationMs,
        finalOutput,
        assertionResults,
        metrics: cloneMetrics(state.metrics),
        judge: judgeResult,
        judgeError,
        error: agentError,
      });
    } finally {
      process.chdir(originalCwd);
      await workspace.cleanup();
    }
  }

  progress(`[${parsed.caseId}] 评测完成（${REPEAT_COUNT} 轮）`);

  return {
    caseId: parsed.caseId,
    name: parsed.name,
    runs,
    aggregate: aggregateRuns(runs),
  };
}

function createItemEvaluator() {
  return async ({ output }: { output: EvalItemOutput }): Promise<Evaluation[]> => {
    const evaluations: Evaluation[] = [];
    pushScore(evaluations, "任务成功率", output.aggregate.successRate);
    pushScore(evaluations, "准确性", judgeDimensionMean(output.runs, "accuracy"));
    pushScore(evaluations, "相关性", judgeDimensionMean(output.runs, "relevance"));
    pushScore(evaluations, "完整性", judgeDimensionMean(output.runs, "completeness"));
    pushScore(evaluations, "改动纪律", judgeDimensionMean(output.runs, "changeDiscipline"));
    pushScore(evaluations, "稳定性", output.aggregate.stabilityRate);
    pushScore(evaluations, "平均耗时(ms)", output.aggregate.durationMeanMs);
    pushScore(evaluations, "模型耗时(ms)", output.aggregate.modelDurationMeanMs);
    pushScore(evaluations, "首 Token 延迟(ms)", output.aggregate.firstTokenLatencyMeanMs);
    pushScore(evaluations, "输入 Token", output.aggregate.inputTokensMean);
    pushScore(evaluations, "输出 Token", output.aggregate.outputTokensMean);
    pushScore(evaluations, "总 Token", output.aggregate.totalTokensMean);
    pushScore(evaluations, "工具错误率", output.aggregate.toolErrorRate);
    pushScore(evaluations, "重试成功率", output.aggregate.retrySuccessRate);
    pushScore(evaluations, "平均重试次数", output.aggregate.retriesMean);
    return evaluations;
  };
}

function createRunEvaluator() {
  return async ({ itemResults }: { itemResults: Array<{ output: EvalItemOutput }> }) => {
    const runs = itemResults.flatMap((result) => result.output.runs);
    const aggregate = aggregateRuns(runs);
    const evaluations: Evaluation[] = [];
    pushScore(evaluations, "总体任务成功率", aggregate.successRate);
    pushScore(evaluations, "总体质量", aggregate.qualityMean);
    pushScore(evaluations, "总体稳定性", aggregate.stabilityRate);
    pushScore(evaluations, "总体断言通过率", aggregate.assertionPassRate);
    pushScore(evaluations, "总体工具错误率", aggregate.toolErrorRate);
    pushScore(evaluations, "总体重试成功率", aggregate.retrySuccessRate);
    return evaluations;
  };
}

interface ParsedDatasetItem {
  caseId: string;
  name: string;
  prompt: string;
  files: Record<string, string>;
  objective: string;
  assertions: AssertionSpec[];
}

function parseDatasetItem(item: ExperimentTaskParams): ParsedDatasetItem {
  const record = asObject(item, "Dataset Item");
  const input = asObject(record.input, "input");
  const expectedOutput = asObject(record.expectedOutput, "expectedOutput");
  const metadata = asObject(record.metadata, "metadata");
  const prompt = requiredString(input.prompt, "input.prompt");
  const objective = requiredString(expectedOutput.objective, "expectedOutput.objective");
  const files = stringRecord(input.files, "input.files");
  if (!Array.isArray(metadata.assertions) || !metadata.assertions.every(isAssertionSpec)) {
    throw new Error("metadata.assertions 必须是有效的断言数组");
  }
  const caseId = typeof record.id === "string"
    ? record.id
    : requiredString(metadata.caseId, "metadata.caseId");
  const name = typeof metadata.name === "string" ? metadata.name : caseId;
  return {
    caseId,
    name,
    prompt,
    files,
    objective,
    assertions: metadata.assertions,
  };
}

function isAssertionSpec(value: unknown): value is AssertionSpec {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }
  const spec = value as Record<string, unknown>;
  switch (spec.type) {
    case "file_exists":
    case "file_not_exists":
      return typeof spec.path === "string";
    case "file_contains":
    case "file_not_contains":
      return typeof spec.path === "string" && typeof spec.text === "string";
    case "command_succeeds":
      return typeof spec.command === "string";
    case "final_contains":
    case "final_not_contains":
      return typeof spec.text === "string";
    case "todos_completed":
      return true;
    default:
      return false;
  }
}

function latestAssistantText(state: State): string {
  for (let index = state.messages.length - 1; index >= 0; index -= 1) {
    const message = state.messages[index];
    if (message?.role !== "assistant") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

function formatAssertionSummary(results: AssertionResult[]): string {
  const passed = results.filter((result) => result.passed).length;
  return [
    `${passed}/${results.length} 个确定性断言通过`,
    ...results.map((result) => `${result.passed ? "通过" : "失败"}：${result.message}`),
  ].join("\n");
}

function judgeQuality(result: JudgeResult): number {
  return (
    result.accuracy.score +
    result.relevance.score +
    result.completeness.score +
    result.changeDiscipline.score
  ) / 4;
}

function judgeDimensionMean(
  runs: EvalRunResult[],
  dimension: keyof JudgeResult,
): number | undefined {
  const values = runs
    .map((run) => run.judge?.[dimension].score)
    .filter((value): value is number => value !== undefined);
  return values.length === 0
    ? undefined
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function pushScore(
  evaluations: Evaluation[],
  name: string,
  value: number | undefined,
): void {
  if (value !== undefined) evaluations.push({ name, value });
}

function cloneMetrics(metrics: AgentMetrics): AgentMetrics {
  return {
    ...metrics,
    firstTokenLatenciesMs: [...metrics.firstTokenLatenciesMs],
  };
}

function asObject(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${field} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value) throw new Error(`${field} 必须是字符串`);
  return value;
}

function stringRecord(value: unknown, field: string): Record<string, string> {
  const record = asObject(value, field);
  if (!Object.values(record).every((item) => typeof item === "string")) {
    throw new Error(`${field} 的值必须都是字符串`);
  }
  return record as Record<string, string>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
