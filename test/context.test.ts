import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";
import { createContextManager } from "@/context/manager.js";
import { createState } from "@/core/state.js";

describe("ContextManager", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  test("budget 最先落盘，再由 micro 压缩旧工具结果", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-context-"));
    directories.push(root);
    const state = createState();
    state.messages.push(
      assistantToolUse("old-tool"),
      toolResult("old-tool", "旧".repeat(200)),
      assistantToolUse("new-tool"),
      toolResult("new-tool", "新".repeat(200)),
    );
    const manager = createContextManager({
      root,
      toolResultBudget: 100,
      toolResultPreview: 12,
      toolResultPersistThreshold: 100,
      keepRecentToolResults: 1,
      maxMessages: 50,
      compactThreshold: Number.POSITIVE_INFINITY,
    });

    await manager.manage(state);

    const persisted = await readdir(join(root, ".task_outputs", "tool-results"));
    expect(persisted).toHaveLength(1);
    expect(await readFile(join(root, ".task_outputs", "tool-results", persisted[0]!), "utf8"))
      .toContain("新");
    expect(JSON.stringify(state.messages[1])).toContain("Earlier tool result compacted");
    expect(JSON.stringify(state.messages[3])).toContain("persisted-output");
  });

  test("snip 不拆散 tool_use 与 tool_result", async () => {
    const state = createState();
    state.messages.push(
      { role: "user", content: "head-1" },
      assistantToolUse("head-tool"),
      toolResult("head-tool", "head-result"),
      { role: "assistant", content: "middle" },
      assistantToolUse("tail-tool"),
      toolResult("tail-tool", "tail-result"),
      { role: "assistant", content: "tail" },
    );
    const manager = createContextManager({
      maxMessages: 5,
      keepHeadMessages: 2,
      keepRecentToolResults: 10,
      toolResultBudget: Number.POSITIVE_INFINITY,
      compactThreshold: Number.POSITIVE_INFINITY,
    });

    await manager.manage(state);

    const serialized = JSON.stringify(state.messages);
    expect(serialized).toContain("head-tool");
    expect(serialized).toContain("head-result");
    expect(serialized).toContain("tail-tool");
    expect(serialized).toContain("tail-result");
    expect(serialized).toContain("snipped");
  });

  test("超过阈值时保存 transcript 并用 LLM 摘要替换历史", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-compact-"));
    directories.push(root);
    const state = createState();
    state.messages.push({ role: "user", content: "需要压缩的长上下文" });
    let summarized: MessageParam[] | undefined;
    const manager = createContextManager({
      root,
      compactThreshold: 1,
      summarize: async (messages) => {
        summarized = messages;
        return "目标、发现和剩余工作";
      },
    });

    await manager.manage(state);

    expect(summarized).toHaveLength(1);
    expect(state.messages).toEqual([
      { role: "user", content: "[Compacted]\n\n目标、发现和剩余工作" },
    ]);
    expect(await readdir(join(root, ".transcripts"))).toHaveLength(1);
  });

  test("reactiveCompact 保留最近的完整工具调用对", async () => {
    const state = createState();
    state.messages.push(
      { role: "user", content: "old" },
      { role: "assistant", content: "old-answer" },
      assistantToolUse("recent-tool"),
      toolResult("recent-tool", "recent-result"),
      { role: "assistant", content: "recent-answer" },
    );
    const manager = createContextManager({
      reactiveTailMessages: 2,
      summarize: async () => "较早历史摘要",
    });

    await manager.reactiveCompact(state);

    expect(state.messages[0]).toEqual({
      role: "user",
      content: "[Reactive compact]\n\n较早历史摘要",
    });
    expect(JSON.stringify(state.messages)).toContain("recent-tool");
    expect(JSON.stringify(state.messages)).toContain("recent-result");
  });
});

function assistantToolUse(id: string): MessageParam {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name: "read_file", input: { path: id } }],
  };
}

function toolResult(id: string, content: string): MessageParam {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: id, content }],
  };
}
