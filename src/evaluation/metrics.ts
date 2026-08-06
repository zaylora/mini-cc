import type { AssertionResult } from "@/evaluation/types.js";

export interface MetricRun {
  caseId?: string;
  repeat?: number;
  success: boolean;
  quality?: number;
  durationMs: number;
  assertionResults: Array<Pick<AssertionResult, "passed">>;
  metrics?: {
    inputTokens: number;
    outputTokens: number;
    toolCalls: number;
    toolErrors: number;
    retries: number;
    modelCalls?: number;
    modelDurationMs?: number;
    firstTokenLatenciesMs?: number[];
    toolDurationMs?: number;
  };
}

export interface AggregateMetrics {
  runCount: number;
  successRate?: number;
  firstPassSuccessRate?: number;
  assertionPassRate?: number;
  subtaskCompletionRate?: number;
  qualityMean?: number;
  qualityStdDev?: number;
  durationMeanMs?: number;
  durationStdDevMs?: number;
  inputTokensMean?: number;
  outputTokensMean?: number;
  totalTokensMean?: number;
  toolErrorRate?: number;
  retrySuccessRate?: number;
  successStdDev?: number;
  stabilityRate?: number;
  modelCallsMean?: number;
  modelDurationMeanMs?: number;
  firstTokenLatencyMeanMs?: number;
  toolDurationMeanMs?: number;
  retriesMean?: number;
}

export function aggregateRuns(runs: MetricRun[]): AggregateMetrics {
  const successes = runs.map((run) => run.success ? 1 : 0);
  const firstPasses = runs
    .filter((run) => run.repeat === 1)
    .map((run) => run.success ? 1 : 0);
  const assertions = runs.flatMap((run) => run.assertionResults);
  const qualities = defined(runs.map((run) => run.quality));
  const durations = runs.map((run) => run.durationMs);
  const inputTokens = defined(runs.map((run) => run.metrics?.inputTokens));
  const outputTokens = defined(runs.map((run) => run.metrics?.outputTokens));
  const retryRuns = runs.filter((run) => (run.metrics?.retries ?? 0) > 0);
  const modelCalls = defined(runs.map((run) => run.metrics?.modelCalls));
  const modelDurations = defined(runs.map((run) => run.metrics?.modelDurationMs));
  const firstTokenLatencies = runs.flatMap(
    (run) => run.metrics?.firstTokenLatenciesMs ?? [],
  );
  const toolDurations = defined(runs.map((run) => run.metrics?.toolDurationMs));
  const retries = defined(runs.map((run) => run.metrics?.retries));
  const totalToolCalls = sum(runs.map((run) => run.metrics?.toolCalls ?? 0));
  const totalToolErrors = sum(runs.map((run) => run.metrics?.toolErrors ?? 0));
  const assertionPassRate = ratio(
    assertions.filter((result) => result.passed).length,
    assertions.length,
  );

  return {
    runCount: runs.length,
    successRate: mean(successes),
    firstPassSuccessRate: mean(firstPasses),
    assertionPassRate,
    subtaskCompletionRate: assertionPassRate,
    qualityMean: mean(qualities),
    qualityStdDev: standardDeviation(qualities),
    durationMeanMs: mean(durations),
    durationStdDevMs: standardDeviation(durations),
    inputTokensMean: mean(inputTokens),
    outputTokensMean: mean(outputTokens),
    totalTokensMean: mean(inputTokens.map((value, index) =>
      value + (outputTokens[index] ?? 0))),
    toolErrorRate: ratio(totalToolErrors, totalToolCalls),
    retrySuccessRate: ratio(
      retryRuns.filter((run) => run.success).length,
      retryRuns.length,
    ),
    successStdDev: standardDeviation(successes),
    stabilityRate: runs.length === 0
      ? undefined
      : Math.max(sum(successes), runs.length - sum(successes)) / runs.length,
    modelCallsMean: mean(modelCalls),
    modelDurationMeanMs: mean(modelDurations),
    firstTokenLatencyMeanMs: mean(firstTokenLatencies),
    toolDurationMeanMs: mean(toolDurations),
    retriesMean: mean(retries),
  };
}

function defined(values: Array<number | undefined>): number[] {
  return values.filter((value): value is number => value !== undefined);
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function ratio(numerator: number, denominator: number): number | undefined {
  return denominator === 0 ? undefined : numerator / denominator;
}

function mean(values: number[]): number | undefined {
  return values.length === 0 ? undefined : sum(values) / values.length;
}

function standardDeviation(values: number[]): number | undefined {
  const average = mean(values);
  if (average === undefined) return undefined;
  return Math.sqrt(
    sum(values.map((value) => (value - average) ** 2)) / values.length,
  );
}
