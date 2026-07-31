import { describe, expect, test } from "bun:test";
import { HookBus } from "@/hooks/bus.js";

describe("HookBus", () => {
  test("按优先级执行 PreToolUse 并在首个非 continue 结果处短路", async () => {
    const calls: string[] = [];
    const bus = new HookBus();
    bus.register("PreToolUse", async () => {
      calls.push("low");
      return { action: "continue" };
    });
    bus.register(
      "PreToolUse",
      async () => {
        calls.push("high");
        return { action: "block", reason: "blocked" };
      },
      { priority: 100 },
    );

    expect(
      await bus.trigger("PreToolUse", { toolName: "bash", input: {} }),
    ).toEqual({ action: "block", reason: "blocked" });
    expect(calls).toEqual(["high"]);
  });

  test("依次合并 UserPromptSubmit 与 PostToolUse 的注入内容", async () => {
    const bus = new HookBus();
    bus.register("UserPromptSubmit", async () => ({
      action: "inject",
      context: "first",
    }));
    bus.register("UserPromptSubmit", async () => ({
      action: "inject",
      context: "second",
    }));

    expect(
      await bus.trigger("UserPromptSubmit", { prompt: "hello" }),
    ).toEqual({ action: "inject", context: "first\nsecond" });
  });
});
