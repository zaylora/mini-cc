import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  MessageParam,
  ToolResultBlockParam,
} from "@anthropic-ai/sdk/resources/messages/messages";
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
      microCompactThreshold: 1,
      compactThreshold: Number.POSITIVE_INFINITY,
    });

    await manager.manage(state);

    const persisted = await readdir(join(root, ".task_outputs", "tool-results"));
    expect(persisted).toHaveLength(1);
    expect(await readFile(join(root, ".task_outputs", "tool-results", persisted[0]!), "utf8"))
      .toContain("新");
    expect(JSON.stringify(state.messages[1])).toContain("Compacted");
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

  test("micro 占位符保留工具名与参数，且不诱导重跑", async () => {
    const state = createState();
    state.messages.push(
      assistantToolUse("old-tool"),
      toolResult("old-tool", "旧".repeat(200)),
      assistantToolUse("new-tool"),
      toolResult("new-tool", "新".repeat(200)),
    );
    const manager = createContextManager({
      keepRecentToolResults: 1,
      toolResultBudget: Number.POSITIVE_INFINITY,
      compactThreshold: Number.POSITIVE_INFINITY,
      microCompactThreshold: 1,
    });

    await manager.manage(state);

    const placeholder = toolResultText(state.messages[1]!);
    expect(placeholder).toContain("read_file");
    expect(placeholder).toContain("old-tool");
    expect(placeholder).not.toContain("Re-run");
    expect(placeholder).not.toContain("旧");
  });

  test("上下文未达 micro 门槛时保留工具结果原文", async () => {
    const state = createState();
    state.messages.push(
      assistantToolUse("old-tool"),
      toolResult("old-tool", "旧".repeat(200)),
      assistantToolUse("new-tool"),
      toolResult("new-tool", "新".repeat(200)),
    );
    const manager = createContextManager({
      keepRecentToolResults: 1,
      toolResultBudget: Number.POSITIVE_INFINITY,
      compactThreshold: Number.POSITIVE_INFINITY,
      microCompactThreshold: Number.POSITIVE_INFINITY,
    });

    await manager.manage(state);

    expect(toolResultText(state.messages[1]!)).toContain("旧");
  });

  test("micro 压缩保留落盘引用的恢复路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-persist-micro-"));
    directories.push(root);
    const state = createState();
    state.messages.push(
      assistantToolUse("big-one"),
      toolResult("big-one", "X".repeat(500)),
    );
    await createContextManager({
      root,
      toolResultBudget: 100,
      toolResultPreview: 12,
      toolResultPersistThreshold: 100,
      microCompactThreshold: Number.POSITIVE_INFINITY,
      compactThreshold: Number.POSITIVE_INFINITY,
    }).manage(state);
    const persistedPath = /path="([^"]+)"/.exec(
      toolResultText(state.messages[1]!),
    )?.[1];
    expect(persistedPath).toBeDefined();

    state.messages.push(
      assistantToolUse("later-one"),
      toolResult("later-one", "Y".repeat(500)),
    );
    await createContextManager({
      root,
      toolResultBudget: Number.POSITIVE_INFINITY,
      keepRecentToolResults: 1,
      microCompactThreshold: 1,
      compactThreshold: Number.POSITIVE_INFINITY,
    }).manage(state);

    const compacted = toolResultText(state.messages[1]!);
    expect(compacted).toContain(persistedPath!);
    expect(compacted).not.toContain("XXX");
    expect(compacted.length).toBeLessThan(500);
  });

  test("多条中等结果累加超预算时按大小依次落盘", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-budget-sum-"));
    directories.push(root);
    const state = createState();
    const blocks: ToolResultBlockParam[] = [];
    for (let index = 0; index < 10; index += 1) {
      state.messages.push(assistantToolUse(`tool-${index}`));
      blocks.push({
        type: "tool_result",
        tool_use_id: `tool-${index}`,
        content: "M".repeat(1_000),
      });
    }
    state.messages.push({ role: "user", content: blocks });

    await createContextManager({
      root,
      toolResultBudget: 3_000,
      toolResultPreview: 40,
      toolResultPersistThreshold: 100_000,
      microCompactThreshold: Number.POSITIVE_INFINITY,
      compactThreshold: Number.POSITIVE_INFINITY,
    }).manage(state);

    const persisted = await readdir(join(root, ".task_outputs", "tool-results"));
    expect(persisted.length).toBeGreaterThan(0);
    const total = blocks.reduce(
      (sum, block) => sum + String(block.content).length,
      0,
    );
    expect(total).toBeLessThanOrEqual(3_000);
  });

  test("落盘换不来体积收益时不写文件", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-budget-noop-"));
    directories.push(root);
    const state = createState();
    state.messages.push(
      assistantToolUse("tiny-a"),
      assistantToolUse("tiny-b"),
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tiny-a", content: "a".repeat(60) },
          { type: "tool_result", tool_use_id: "tiny-b", content: "b".repeat(60) },
        ],
      },
    );

    await createContextManager({
      root,
      toolResultBudget: 10,
      toolResultPreview: 2_000,
      toolResultPersistThreshold: 20,
      microCompactThreshold: Number.POSITIVE_INFINITY,
      compactThreshold: Number.POSITIVE_INFINITY,
    }).manage(state);

    expect(await readdir(root)).not.toContain(".task_outputs");
  });

  test("字符数很小但真实 token 已超阈值时仍触发 LLM 摘要", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-token-"));
    directories.push(root);
    const state = createState();
    state.messages.push({ role: "user", content: "很短的一条消息" });
    state.lastInputTokens = 180_000;
    let summarized = false;
    const manager = createContextManager({
      root,
      compactThreshold: 150_000,
      summarize: async () => {
        summarized = true;
        return "目标与剩余工作";
      },
    });

    await manager.manage(state);

    expect(summarized).toBe(true);
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

function toolResultText(message: MessageParam): string {
  const blocks = message.content as ToolResultBlockParam[];
  return String(blocks[0]!.content);
}
