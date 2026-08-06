import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { evaluateAssertions } from "@/evaluation/assertions.js";
import { createEvalWorkspace } from "@/evaluation/workspace.js";

describe("评测工作区与断言", () => {
  const cleanupTasks: Array<() => Promise<void>> = [];

  afterEach(async () => {
    await Promise.all(cleanupTasks.splice(0).map((cleanup) => cleanup()));
  });

  test("夹具只写入临时目录并执行文件、命令和结果断言", async () => {
    const workspace = await createEvalWorkspace({
      "nested/answer.txt": "完成\n",
    });
    cleanupTasks.push(workspace.cleanup);

    const results = await evaluateAssertions(workspace.path, {
      finalOutput: "任务完成",
      todos: [{ content: "写答案", status: "completed" }],
    }, [
      { type: "file_exists", path: "nested/answer.txt" },
      { type: "file_contains", path: "nested/answer.txt", text: "完成" },
      { type: "command_succeeds", command: "bun --version" },
      { type: "final_contains", text: "任务完成" },
      { type: "todos_completed" },
    ]);

    expect(results.every((result) => result.passed)).toBe(true);
  });

  test("支持指定评测工作区父目录", async () => {
    const parentRoot = await mkdtemp(`${tmpdir()}\\mini-cc-parent-`);
    const workspace = await createEvalWorkspace({ "answer.txt": "完成\n" }, parentRoot);
    cleanupTasks.push(async () => {
      await workspace.cleanup();
      await rm(parentRoot, { recursive: true, force: true });
    });

    expect(workspace.path.startsWith(parentRoot)).toBe(true);
  });

  test("拒绝逃出临时工作区的夹具和文件断言", async () => {
    await expect(createEvalWorkspace({ "../outside.txt": "禁止" }))
      .rejects.toThrow("评测工作区");

    const workspace = await createEvalWorkspace({});
    cleanupTasks.push(workspace.cleanup);
    const [result] = await evaluateAssertions(workspace.path, {
      finalOutput: "",
      todos: [],
    }, [{ type: "file_exists", path: "../outside.txt" }]);

    expect(result).toMatchObject({ passed: false });
    expect(result?.message).toContain("评测工作区");
  });
});
