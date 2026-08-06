import { describe, expect, test } from "bun:test";
import type { FetchedDataset, LangfuseClient } from "@langfuse/client";
import { BUILTIN_CASES } from "@/evaluation/cases.js";
import { runEvaluationCli } from "@/evaluation/cli.js";
import { createRecordingTelemetry } from "../helpers/recordingTelemetry.js";

describe("评测 CLI", () => {
  test("缺少 Langfuse 配置时返回 1 且不创建客户端", async () => {
    const errors: string[] = [];
    let clientCreated = false;

    const exitCode = await runEvaluationCli({
      env: {},
      stderr: { write: (text) => errors.push(text) },
      createClient: () => {
        clientCreated = true;
        throw new Error("不应执行");
      },
    });

    expect(exitCode).toBe(1);
    expect(clientCreated).toBe(false);
    expect(errors.join("")).toContain("LANGFUSE_PUBLIC_KEY");
  });

  test("成功时输出格式化结果和 URL，并关闭两个生命周期", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const telemetry = createRecordingTelemetry();
    let clientShutdownCount = 0;
    let createItemCount = 0;
    const dataset = {
      runExperiment: async () => ({
        experimentId: "experiment-1",
        runName: "run-1",
        datasetRunId: "dataset-run-1",
        datasetRunUrl: "https://cloud.langfuse.com/run/1",
        itemResults: [],
        runEvaluations: [],
        format: async () => "评测完成",
      }),
    } as unknown as FetchedDataset;
    const client = {
      api: {
        datasets: {
          get: async () => ({ name: "mini-cc-test" }),
          create: async () => ({ name: "mini-cc-test" }),
        },
      },
      dataset: {
        createItem: async (item: unknown) => {
          createItemCount += 1;
          return item;
        },
        get: async () => dataset,
      },
      shutdown: async () => {
        clientShutdownCount += 1;
      },
    } as unknown as LangfuseClient;

    const exitCode = await runEvaluationCli({
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
        LANGFUSE_DATASET_NAME: "mini-cc-test",
      },
      stdout: { write: (text) => output.push(text) },
      stderr: { write: (text) => errors.push(text) },
      createClient: () => client,
      createObservability: async () => ({
        telemetry,
        shutdown: (timeoutMs) => telemetry.shutdown(timeoutMs),
      }),
      scanSkills: async () => new Map(),
      getGitCommit: () => "abc123",
      getModelId: () => "test-model",
      now: () => new Date("2026-08-06T00:00:00.000Z"),
    });

    expect(exitCode).toBe(0);
    expect(createItemCount).toBe(BUILTIN_CASES.length);
    expect(output.join("")).toContain("评测完成");
    expect(output.join("")).toContain("https://cloud.langfuse.com/run/1");
    expect(errors.join("")).toContain("[评测] 正在初始化 Langfuse");
    expect(errors.join("")).toContain("[评测] 正在同步数据集：mini-cc-test");
    expect(errors.join("")).toContain("[评测] 正在加载评测数据集");
    expect(errors.join("")).toContain("[评测] 正在扫描 Skills");
    expect(errors.join("")).toContain("[评测] 开始运行实验：mini-cc-core-eval-2026-08-06T00:00:00.000Z");
    expect(errors.join("")).toContain("[评测] 实验运行完成");
    expect(telemetry.shutdownCount).toBe(1);
    expect(clientShutdownCount).toBe(1);
  });
});
