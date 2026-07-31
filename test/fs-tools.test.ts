import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dispatch, TOOLS } from "@/tools/registry.js";

describe("文件工具", () => {
  let originalCwd: string;
  let workdir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workdir = await mkdtemp(join(tmpdir(), "mini-agent-fs-"));
    process.chdir(workdir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  test("注册四个专用文件工具", () => {
    expect(TOOLS.map((tool) => tool.name)).toEqual([
      "bash",
      "read_file",
      "write_file",
      "edit_file",
      "glob",
    ]);
  });

  test("写入并读取 UTF-8 文件", async () => {
    await dispatch("write_file", { path: "note.txt", content: "你好" });
    expect(await dispatch("read_file", { path: "note.txt" })).toBe("你好");
  });

  test("只替换第一处匹配文本", async () => {
    await writeFile("sample.ts", "var first = 1;\nvar second = 2;\n");
    await dispatch("edit_file", {
      path: "sample.ts",
      old_text: "var",
      new_text: "let",
    });

    expect(await readFile("sample.ts", "utf8")).toBe(
      "let first = 1;\nvar second = 2;\n",
    );
  });

  test("找不到原文时返回可重试的错误", async () => {
    await writeFile("sample.ts", "const value = 1;\n");
    await expect(
      dispatch("edit_file", {
        path: "sample.ts",
        old_text: "missing",
        new_text: "replacement",
      }),
    ).rejects.toThrow("未在 sample.ts 中找到 old_text");
  });

  test("按 glob 模式返回工作目录内的文件", async () => {
    await Bun.write("first.ts", "");
    await Bun.write("second.js", "");

    expect(await dispatch("glob", { pattern: "*.ts" })).toBe("first.ts");
  });

  test("所有文件工具拒绝访问工作目录外", async () => {
    const inputs = [
      ["read_file", { path: "../outside.txt" }],
      ["write_file", { path: "../outside.txt", content: "x" }],
      ["edit_file", { path: "../outside.txt", old_text: "x", new_text: "y" }],
      ["glob", { pattern: "../*.txt" }],
    ] as const;

    for (const [name, input] of inputs) {
      await expect(dispatch(name, input)).rejects.toThrow("路径必须位于工作目录内");
    }
  });
});
