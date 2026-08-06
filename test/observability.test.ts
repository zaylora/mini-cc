import { describe, expect, test } from "bun:test";
import { createObservability } from "@/observability/index.js";
import { createLangfuseTelemetryRuntime } from "@/observability/langfuse.js";
import { noopTelemetry } from "@/observability/noop.js";
import type { ObservationAttributes } from "@/observability/types.js";
import { createRecordingTelemetry } from "./helpers/recordingTelemetry.js";

describe("Telemetry", () => {
  test("空遥测执行回调并保持返回值和异常", async () => {
    expect(
      await noopTelemetry.observe(
        "agent",
        { asType: "agent" },
        async () => 42,
      ),
    ).toBe(42);
    await expect(
      noopTelemetry.observe(
        "agent",
        { asType: "agent" },
        async () => {
          throw new Error("boom");
        },
      ),
    ).rejects.toThrow("boom");
  });

  test("记录实现保留嵌套层级和更新属性", async () => {
    const telemetry = createRecordingTelemetry();
    await telemetry.observe(
      "agent",
      { asType: "agent", input: "任务" },
      async (agent) => {
        await telemetry.observe(
          "model",
          { asType: "generation", model: "test-model" },
          async (generation) => {
            generation.update({ output: "完成", usageDetails: { input: 2 } });
          },
        );
        telemetry.event("retry", { metadata: { attempt: 1 } });
        agent.update({ output: "完成" });
      },
    );

    expect(telemetry.tree()).toMatchObject([
      {
        name: "agent",
        type: "agent",
        attributes: { input: "任务", output: "完成" },
        children: [
          {
            name: "model",
            type: "generation",
            attributes: {
              model: "test-model",
              output: "完成",
              usageDetails: { input: 2 },
            },
          },
          {
            name: "retry",
            type: "event",
            attributes: { metadata: { attempt: 1 } },
          },
        ],
      },
    ]);
  });

  test("无配置返回空实现，部分配置只警告一次", async () => {
    const warnings: string[] = [];
    const disabled = await createObservability({
      env: {},
      warn: (message) => warnings.push(message),
    });
    expect(disabled.telemetry.enabled).toBe(false);
    expect(warnings).toEqual([]);

    const partial = await createObservability({
      env: { LANGFUSE_PUBLIC_KEY: "pk-test" },
      warn: (message) => warnings.push(message),
    });
    expect(partial.telemetry.enabled).toBe(false);
    expect(warnings).toEqual([
      "Langfuse 需要同时配置 LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY",
    ]);
  });

  test("完整配置交给启用工厂且关闭生命周期只调用遥测", async () => {
    const telemetry = createRecordingTelemetry();
    const seen: unknown[] = [];
    const lifecycle = await createObservability({
      env: {
        LANGFUSE_PUBLIC_KEY: "pk-test",
        LANGFUSE_SECRET_KEY: "sk-test",
      },
      createEnabledTelemetry: (config) => {
        seen.push(config);
        return telemetry;
      },
    });

    expect(lifecycle.telemetry).toBe(telemetry);
    expect(seen).toEqual([{
      publicKey: "pk-test",
      secretKey: "sk-test",
      baseUrl: "https://cloud.langfuse.com",
    }]);
    await lifecycle.shutdown();
    expect(telemetry.shutdownCount).toBe(1);
  });

  test("Langfuse 适配器结束 event 并合并多次 observation 更新", async () => {
    const updates: ObservationAttributes[] = [];
    let eventEndCount = 0;
    const telemetry = createLangfuseTelemetryRuntime(
      {
        publicKey: "pk-test",
        secretKey: "sk-test",
        baseUrl: "https://cloud.langfuse.com",
      },
      () => {},
      {
        createProcessor: () => ({ forceFlush: async () => {} }),
        createSdk: () => ({ start: () => {}, shutdown: async () => {} }),
        startActive: async (_name, run) => run({
          traceId: "trace-1",
          update: (attributes) => updates.push(attributes),
        }),
        startEvent: () => ({ end: () => { eventEndCount += 1; } }),
      },
    );

    await telemetry.observe("tool", {
      asType: "tool",
      metadata: { toolUseId: "tool-1", depth: 0 },
    }, async (observation) => {
      observation.update({ output: "完成", metadata: { durationMs: 12 } });
      observation.update({ statusMessage: undefined, metadata: { isError: false } });
    });
    telemetry.event("retry", { metadata: { attempt: 1 } });

    expect(updates.at(-1)).toMatchObject({
      output: "完成",
      metadata: {
        toolUseId: "tool-1",
        depth: 0,
        durationMs: 12,
        isError: false,
      },
    });
    expect(updates.at(-1)).not.toHaveProperty("statusMessage");
    expect(eventEndCount).toBe(1);
  });
});
