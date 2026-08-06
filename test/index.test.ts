import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { main, parseWorkingDirectory, shouldUseTui } from "@/cli/main.js";
import { HookBus } from "@/hooks/bus.js";
import { dispatch } from "@/tools/registry.js";
import { createRecordingTelemetry } from "./helpers/recordingTelemetry.js";

test("包入口可以正常加载", async () => {
  const entry = await import("@/index.js");
  expect(entry.noopTelemetry).toBeDefined();
});

test("TUI 退出后关闭 observability 生命周期", async () => {
  const telemetry = createRecordingTelemetry();
  let receivedTelemetry: unknown;

  await main([], {
    input: { isTTY: true } as NodeJS.ReadStream,
    output: { isTTY: true, write: () => true } as unknown as NodeJS.WriteStream,
    scanSkills: async () => new Map(),
    createHookBus: () => new HookBus(),
    createObservability: async () => ({
      telemetry,
      shutdown: (timeoutMs) => telemetry.shutdown(timeoutMs),
    }),
    renderTui: (props) => {
      receivedTelemetry = props.telemetry;
      return { waitUntilExit: async () => {} };
    },
  });

  expect(receivedTelemetry).toBe(telemetry);
  expect(telemetry.shutdownCount).toBe(1);
});

describe("工作目录", () => {
  test("默认使用当前目录", () => {
    expect(parseWorkingDirectory([])).toBe(process.cwd());
  });

  test("允许通过 --cwd 指定任意目录", () => {
    const directory = join(tmpdir(), "..", "mini-agent-test");
    expect(parseWorkingDirectory(["--cwd", directory])).toBe(
      join(tmpdir(), "..", "mini-agent-test"),
    );
  });
});

describe("TTY 判定", () => {
  test("stdin 与 stdout 都是 TTY 时才使用 TUI", () => {
    expect(
      shouldUseTui(
        { isTTY: true } as NodeJS.ReadStream,
        { isTTY: true } as NodeJS.WriteStream,
      ),
    ).toBe(true);
    expect(
      shouldUseTui(
        { isTTY: false } as NodeJS.ReadStream,
        { isTTY: true } as NodeJS.WriteStream,
      ),
    ).toBe(false);
    expect(
      shouldUseTui(
        { isTTY: true } as NodeJS.ReadStream,
        { isTTY: false } as NodeJS.WriteStream,
      ),
    ).toBe(false);
  });
});

describe("bash 工具", () => {
  test("执行命令并返回输出和退出码", async () => {
    const command = process.platform === "win32" ? "Write-Output hello" : "printf hello";
    const result = await dispatch("bash", { command });

    expect(result).toContain("hello");
    expect(result).toContain("exit_code: 0");
  });

  test("拒绝未知工具", async () => {
    await expect(dispatch("missing", {})).rejects.toThrow("未知工具");
  });
});
