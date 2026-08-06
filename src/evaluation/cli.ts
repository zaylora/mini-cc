import { execFileSync } from "node:child_process";
import { LangfuseClient } from "@langfuse/client";
import {
  getLangfuseConfig,
  getModelId,
  type LangfuseConfig,
} from "@/config.js";
import { syncBuiltinDataset } from "@/evaluation/dataset.js";
import { runEvaluationExperiment } from "@/evaluation/runner.js";
import {
  createObservability,
  type CreateObservabilityOptions,
} from "@/observability/index.js";
import type { ObservabilityLifecycle } from "@/observability/types.js";
import { scanSkills } from "@/tools/skill.js";

const DEFAULT_DATASET_NAME = "mini-cc-core-eval";
const SHUTDOWN_TIMEOUT_MS = 2_000;

interface TextOutput {
  write(text: string): unknown;
}

export interface EvaluationCliOptions {
  env?: Record<string, string | undefined>;
  stdout?: TextOutput;
  stderr?: TextOutput;
  createClient?: (config: LangfuseConfig) => LangfuseClient;
  createObservability?: (
    options: CreateObservabilityOptions,
  ) => Promise<ObservabilityLifecycle>;
  scanSkills?: typeof scanSkills;
  getGitCommit?: () => string;
  getModelId?: () => string;
  now?: () => Date;
}

export async function runEvaluationCli(
  options: EvaluationCliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const stdout = options.stdout ?? { write: (text: string) => process.stdout.write(text) };
  const stderr = options.stderr ?? { write: (text: string) => process.stderr.write(text) };
  let client: LangfuseClient | undefined;
  let observability: ObservabilityLifecycle | undefined;

  try {
    writeLine(stderr, "[评测] 正在初始化 Langfuse");
    const config = getLangfuseConfig(env);
    if (!config) {
      throw new Error(
        "运行评测前必须配置 LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY",
      );
    }
    client = (options.createClient ?? ((value) => new LangfuseClient(value)))(config);
    observability = await (options.createObservability ?? createObservability)({
      env,
      warn: (message) => writeLine(stderr, message),
    });
    if (!observability.telemetry.enabled) {
      throw new Error("Langfuse tracing 初始化失败，评测已停止");
    }

    const datasetName = env.LANGFUSE_DATASET_NAME ?? DEFAULT_DATASET_NAME;
    writeLine(stderr, `[评测] 正在同步数据集：${datasetName}`);
    await syncBuiltinDataset(client, datasetName);
    writeLine(stderr, "[评测] 数据集同步完成");
    writeLine(stderr, "[评测] 正在加载评测数据集");
    const dataset = await client.dataset.get(datasetName);
    writeLine(stderr, "[评测] 正在扫描 Skills");
    const skills = await (options.scanSkills ?? scanSkills)();
    const modelId = (options.getModelId ?? getModelId)();
    const now = (options.now ?? (() => new Date()))();
    const runName = `mini-cc-core-eval-${now.toISOString()}`;
    writeLine(stderr, `[评测] 开始运行实验：${runName}`);
    const result = await runEvaluationExperiment(dataset, {
      telemetry: observability.telemetry,
      skills,
      onProgress: (message) => writeLine(stderr, message),
    }, {
      runName,
      gitCommit: (options.getGitCommit ?? readGitCommit)(),
      modelId,
      judgeModelId: modelId,
    });
    writeLine(stderr, "[评测] 实验运行完成");

    writeLine(stdout, await result.format({ includeItemResults: true }));
    if (result.datasetRunUrl) {
      writeLine(stdout, `Langfuse Dataset Run：${result.datasetRunUrl}`);
    }
    return 0;
  } catch (error) {
    writeLine(stderr, `评测失败：${errorMessage(error)}`);
    return 1;
  } finally {
    if (client) {
      writeLine(stderr, "[评测] 正在关闭 Langfuse");
      await settleWithin(
        client.shutdown(),
        SHUTDOWN_TIMEOUT_MS,
        "LangfuseClient 关闭",
        stderr,
      );
    }
    if (observability) {
      writeLine(stderr, "[评测] 正在关闭 OpenTelemetry");
      await settleWithin(
        observability.shutdown(SHUTDOWN_TIMEOUT_MS),
        SHUTDOWN_TIMEOUT_MS,
        "OpenTelemetry 关闭",
        stderr,
      );
    }
  }
}

function readGitCommit(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "unknown";
  } catch {
    return "unknown";
  }
}

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
  action: string,
  stderr: TextOutput,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`${action}超时（${timeoutMs}ms）`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    writeLine(stderr, errorMessage(error));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function writeLine(output: TextOutput, text: string): void {
  output.write(text.endsWith("\n") ? text : `${text}\n`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  runEvaluationCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
