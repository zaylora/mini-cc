import { describe, expect, test } from "bun:test";
import type {
  ExperimentParams,
  ExperimentResult,
  FetchedDataset,
  LangfuseClient,
} from "@langfuse/client";
import { BUILTIN_CASES } from "@/evaluation/cases.js";
import { syncBuiltinDataset } from "@/evaluation/dataset.js";
import {
  runEvaluationExperiment,
  type EvalItemOutput,
} from "@/evaluation/runner.js";
import { createRecordingTelemetry } from "../helpers/recordingTelemetry.js";

describe("Langfuse Dataset 同步", () => {
  test("首次创建 Dataset，稳定 id 重复同步时只做 upsert", async () => {
    const datasets = new Set<string>();
    const items = new Map<string, unknown>();
    let createDatasetCount = 0;
    const client = {
      api: {
        datasets: {
          get: async (name: string) => {
            if (!datasets.has(name)) {
              const error = new Error("not found") as Error & { statusCode: number };
              error.statusCode = 404;
              throw error;
            }
            return { name };
          },
          create: async ({ name }: { name: string }) => {
            createDatasetCount += 1;
            datasets.add(name);
            return { name };
          },
        },
      },
      dataset: {
        createItem: async (item: { id?: string }) => {
          items.set(item.id!, item);
          return item;
        },
      },
    } as unknown as Pick<LangfuseClient, "api" | "dataset">;

    await syncBuiltinDataset(client, "mini-cc-test");
    await syncBuiltinDataset(client, "mini-cc-test");

    expect(createDatasetCount).toBe(1);
    expect(items.size).toBe(BUILTIN_CASES.length);
    expect([...items.keys()]).toEqual(BUILTIN_CASES.map((item) => item.id));
  });
});

describe("Experiment Runner", () => {
  test("每个 Item 顺序运行三次，单次失败不阻止后续运行", async () => {
    const telemetry = createRecordingTelemetry();
    const workingDirectories: string[] = [];
    let calls = 0;
    let taskOutput: EvalItemOutput | undefined;
    let seenMaxConcurrency: number | undefined;
    let evaluatorNames: string[] = [];
    const progress: string[] = [];
    const item = {
      id: "runner-case",
      input: { prompt: "完成任务", files: {} },
      expectedOutput: { objective: "返回完成" },
      metadata: {
        source: "builtin",
        schemaVersion: 1,
        name: "Runner 测试",
        assertions: [{ type: "final_contains", text: "完成" }],
      },
    };
    const dataset = {
      runExperiment: async (
        params: Omit<ExperimentParams, "data">,
      ): Promise<ExperimentResult> => {
        seenMaxConcurrency = params.maxConcurrency;
        taskOutput = await params.task(item) as EvalItemOutput;
        const evaluations = await Promise.all(
          (params.evaluators ?? []).map((evaluator) => evaluator({
            input: item.input,
            output: taskOutput,
            expectedOutput: item.expectedOutput,
            metadata: item.metadata,
          })),
        );
        evaluatorNames = evaluations.flat().map((evaluation) => evaluation.name);
        await Promise.all((params.runEvaluators ?? []).map((evaluator) => evaluator({
          itemResults: [{
            item,
            input: item.input,
            expectedOutput: item.expectedOutput,
            output: taskOutput,
            evaluations: evaluations.flat(),
          }],
        })));
        return {
          experimentId: "experiment-1",
          runName: "run-1",
          itemResults: [],
          runEvaluations: [],
          format: async () => "formatted",
        };
      },
    } as unknown as FetchedDataset;

    await runEvaluationExperiment(dataset, {
      telemetry,
      runAgent: async (state) => {
        calls += 1;
        workingDirectories.push(process.cwd());
        state.metrics.inputTokens = calls * 10;
        state.metrics.outputTokens = calls;
        state.metrics.toolCalls = 1;
        state.metrics.toolErrors = calls === 2 ? 1 : 0;
        if (calls === 2) throw new Error("第二次失败");
        state.messages.push({ role: "assistant", content: `第 ${calls} 次完成` });
      },
      judge: async () => ({
        accuracy: { score: 0.9, reason: "正确" },
        relevance: { score: 0.8, reason: "相关" },
        completeness: { score: 0.7, reason: "完整" },
        creativity: { score: 0.6, reason: "合理" },
      }),
      onProgress: (message) => progress.push(message),
    }, {
      runName: "run-1",
      gitCommit: "abc123",
      modelId: "agent-model",
      judgeModelId: "judge-model",
    });

    expect(seenMaxConcurrency).toBe(1);
    expect(calls).toBe(3);
    expect(new Set(workingDirectories).size).toBe(3);
    expect(taskOutput?.runs.map((run) => run.success)).toEqual([true, false, true]);
    expect(taskOutput?.runs[2]?.finalOutput).toContain("第 3 次完成");
    expect(progress).toContain("[runner-case] 开始评测：Runner 测试");
    expect(progress).toContain("[runner-case] 第 1/3 轮：Agent 开始运行");
    expect(progress.some((message) => message.startsWith("[runner-case] 第 1/3 轮：Agent 运行完成（"))).toBe(true);
    expect(progress).toContain("[runner-case] 第 1/3 轮：确定性断言完成（1/1 通过）");
    expect(progress).toContain("[runner-case] 第 1/3 轮：Judge 开始评分");
    expect(progress).toContain("[runner-case] 第 1/3 轮：Judge 评分完成");
    expect(progress).toContain("[runner-case] 第 2/3 轮：Agent 运行失败：第二次失败");
    expect(progress).toContain("[runner-case] 评测完成（3 轮）");
    expect(evaluatorNames).toEqual(expect.arrayContaining([
      "任务成功率",
      "准确性",
      "相关性",
      "完整性",
      "创造性",
      "稳定性",
      "输入 Token",
      "工具错误率",
    ]));
  });
});
