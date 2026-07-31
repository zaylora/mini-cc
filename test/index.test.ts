import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseWorkingDirectory } from "@/cli/main.js";
import { dispatch } from "@/tools/registry.js";

test("包入口可以正常加载", async () => {
  await expect(import("@/index.js")).resolves.toBeDefined();
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
