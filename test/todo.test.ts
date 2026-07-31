import { describe, expect, test } from "bun:test";
import { createState } from "@/core/state.js";
import { runTodoWrite } from "@/tools/todo.js";

describe("todo_write", () => {
  test("只更新当前会话的任务列表并渲染进度", async () => {
    const state = createState();
    const otherState = createState();

    const result = await runTodoWrite(state, {
      todos: [
        { content: "读取代码", status: "completed" },
        { content: "实现功能", status: "in_progress" },
        { content: "运行测试", status: "pending" },
      ],
    });

    expect(state.todos).toEqual([
      { content: "读取代码", status: "completed" },
      { content: "实现功能", status: "in_progress" },
      { content: "运行测试", status: "pending" },
    ]);
    expect(otherState.todos).toEqual([]);
    expect(result).toContain("[x] 读取代码");
    expect(result).toContain("[>] 实现功能");
    expect(result).toContain("[ ] 运行测试");
  });

  test("拒绝无效任务状态", async () => {
    const state = createState();

    await expect(
      runTodoWrite(state, {
        todos: [{ content: "错误任务", status: "unknown" }],
      }),
    ).rejects.toThrow("无效的 todo 状态");
  });
});
