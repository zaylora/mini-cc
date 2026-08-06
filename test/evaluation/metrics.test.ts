import { expect, test } from "bun:test";
import { aggregateRuns } from "@/evaluation/metrics.js";

test("聚合成功率、质量、耗时、Token、工具错误和首次成功", () => {
  const result = aggregateRuns([
    {
      caseId: "case-a",
      repeat: 1,
      success: true,
      quality: 0.8,
      durationMs: 100,
      assertionResults: [{ passed: true }],
      metrics: {
        inputTokens: 10,
        outputTokens: 2,
        toolCalls: 2,
        toolErrors: 0,
        retries: 0,
      },
    },
    {
      caseId: "case-a",
      repeat: 2,
      success: false,
      quality: 0.4,
      durationMs: 200,
      assertionResults: [{ passed: false }],
      metrics: {
        inputTokens: 20,
        outputTokens: 4,
        toolCalls: 1,
        toolErrors: 1,
        retries: 1,
      },
    },
    {
      caseId: "case-b",
      repeat: 1,
      success: true,
      quality: 0.6,
      durationMs: 300,
      assertionResults: [{ passed: true }],
      metrics: {
        inputTokens: 30,
        outputTokens: 6,
        toolCalls: 0,
        toolErrors: 0,
        retries: 1,
      },
    },
  ]);

  expect(result).toMatchObject({
    runCount: 3,
    successRate: 2 / 3,
    firstPassSuccessRate: 1,
    assertionPassRate: 2 / 3,
    durationMeanMs: 200,
    inputTokensMean: 20,
    outputTokensMean: 4,
    toolErrorRate: 1 / 3,
    retrySuccessRate: 1 / 2,
  });
  expect(result.qualityMean).toBeCloseTo(0.6);
  expect(result.qualityStdDev).toBeCloseTo(Math.sqrt(0.08 / 3));
  expect(result.durationStdDevMs).toBeCloseTo(Math.sqrt(20_000 / 3));
});

test("没有分母或质量数据时返回 undefined", () => {
  expect(aggregateRuns([])).toMatchObject({
    runCount: 0,
    successRate: undefined,
    qualityMean: undefined,
    toolErrorRate: undefined,
    retrySuccessRate: undefined,
  });
});
