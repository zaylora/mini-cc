import { describe, expect, test } from "bun:test";
import {
  JudgeError,
  judgeOutput,
  type JudgeInput,
} from "@/evaluation/judge.js";
import { createRecordingTelemetry } from "../helpers/recordingTelemetry.js";

const input: JudgeInput = {
  task: "创建 result.txt",
  objective: "文件内容准确且没有无关修改",
  assertionSummary: "1/1 个确定性断言通过",
  finalOutput: "已创建 result.txt",
};

describe("Anthropic Judge", () => {
  test("解析四项 0-1 分数并在无效 JSON 后重试一次", async () => {
    const telemetry = createRecordingTelemetry();
    const responses = [
      "not-json",
      JSON.stringify({
        accuracy: { score: 0.9, reason: "结果正确" },
        relevance: { score: 0.8, reason: "紧扣任务" },
        completeness: { score: 0.7, reason: "覆盖主要要求" },
        creativity: { score: 0.6, reason: "方案合理" },
      }),
    ];

    const result = await judgeOutput(input, {
      telemetry,
      request: async () => responses.shift()!,
    });

    expect(result.accuracy.score).toBe(0.9);
    expect(responses).toHaveLength(0);
    expect(
      telemetry.records.filter((record) => record.type === "generation"),
    ).toHaveLength(2);
    expect(
      telemetry.records.filter((record) => record.name === "judge-retry"),
    ).toHaveLength(1);
  });

  test("记录 Judge 模型和 Token，但不需要 Agent State", async () => {
    const telemetry = createRecordingTelemetry();
    await judgeOutput(input, {
      telemetry,
      modelId: "judge-model",
      request: async () => ({
        text: validResult(),
        model: "judge-model-response",
        inputTokens: 50,
        outputTokens: 20,
      }),
    });

    const generation = telemetry.records.find(
      (record) => record.type === "generation",
    );
    expect(generation?.attributes).toMatchObject({
      model: "judge-model-response",
      usageDetails: { input: 50, output: 20, total: 70 },
    });
  });

  test("第二次仍为越界分数时抛出 JudgeError", async () => {
    let attempts = 0;
    await expect(judgeOutput(input, {
      request: async () => {
        attempts += 1;
        return JSON.stringify({
          accuracy: { score: 1.2, reason: "越界" },
          relevance: { score: 0.8, reason: "正常" },
          completeness: { score: 0.7, reason: "正常" },
          creativity: { score: 0.6, reason: "正常" },
        });
      },
    })).rejects.toBeInstanceOf(JudgeError);
    expect(attempts).toBe(2);
  });
});

function validResult(): string {
  return JSON.stringify({
    accuracy: { score: 0.9, reason: "结果正确" },
    relevance: { score: 0.8, reason: "紧扣任务" },
    completeness: { score: 0.7, reason: "覆盖主要要求" },
    creativity: { score: 0.6, reason: "方案合理" },
  });
}
