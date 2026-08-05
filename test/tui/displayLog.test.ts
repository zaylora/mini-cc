import { expect, test } from "bun:test";
import {
  appendAssistantBlocks,
  appendAssistantMessage,
  appendSystemEntry,
  appendToolStart,
  appendUserEntry,
  applyToolEnd,
  createDisplayLog,
  setStreamingBlocks,
} from "@/tui/model/displayLog.js";

test("append* 依次追加到 staticEntries", () => {
  let log = appendUserEntry(createDisplayLog(), "你好");
  log = appendAssistantMessage(log, { text: "收到", depth: 0 });
  log = appendSystemEntry(log, "系统提示");
  expect(log.pendingEntries).toEqual([]);
  expect(log.staticEntries).toMatchObject([
    { kind: "user", text: "你好" },
    { kind: "assistant-block", block: { kind: "paragraph" }, depth: 0 },
    { kind: "system", text: "系统提示" },
  ]);
});

test("appendToolStart 追加到 pendingEntries", () => {
  const log = appendToolStart(createDisplayLog(), {
    id: "t1",
    toolName: "bash",
    input: { command: "ls" },
    depth: 0,
  });
  expect(log.staticEntries).toEqual([]);
  expect(log.pendingEntries).toMatchObject([
    { kind: "tool", id: "t1", toolName: "bash", input: { command: "ls" }, depth: 0 },
  ]);
});

test("applyToolEnd 把完成的工具条目从 pendingEntries 迁移到 staticEntries", () => {
  let log = appendToolStart(createDisplayLog(), {
    id: "t1",
    toolName: "bash",
    input: { command: "ls" },
    depth: 0,
  });
  log = applyToolEnd(log, { id: "t1", result: "ok", isError: false });
  expect(log.pendingEntries).toEqual([]);
  expect(log.staticEntries).toMatchObject([
    {
      kind: "tool",
      id: "t1",
      toolName: "bash",
      input: { command: "ls" },
      depth: 0,
      result: "ok",
      isError: false,
    },
  ]);
});

test("嵌套工具：子条目不早于父条目静态化，父完成后整组按开始顺序提交", () => {
  let log = appendToolStart(createDisplayLog(), {
    id: "task1",
    toolName: "task",
    input: { description: "分析 src/core" },
    depth: 0,
  });

  log = appendToolStart(log, { id: "b1", toolName: "bash", input: { command: "ls" }, depth: 1 });
  log = applyToolEnd(log, { id: "b1", result: "ok", isError: false });
  expect(log.staticEntries).toEqual([]);
  expect(log.pendingEntries.map((entry) => entry.id)).toEqual(["task1", "b1"]);

  log = appendToolStart(log, { id: "r1", toolName: "read_file", input: { path: "a.ts" }, depth: 1 });
  log = applyToolEnd(log, { id: "r1", result: "内容", isError: false });
  expect(log.staticEntries).toEqual([]);

  log = applyToolEnd(log, { id: "task1", result: "结论", isError: false });
  expect(log.staticEntries.map((entry) => entry.id)).toEqual(["task1", "b1", "r1"]);
  expect(log.pendingEntries).toEqual([]);
});

test("子 Agent 结论随父 task 一起按事件顺序提交", () => {
  let log = appendToolStart(createDisplayLog(), {
    id: "task1",
    toolName: "task",
    input: { description: "分析 src/core" },
    depth: 0,
  });
  log = appendToolStart(log, {
    id: "read1",
    toolName: "read_file",
    input: { path: "src/core/loop.ts" },
    depth: 1,
  });
  log = applyToolEnd(log, { id: "read1", result: "内容", isError: false });
  log = appendAssistantMessage(log, { text: "core 分析报告", depth: 1 });

  expect(log.staticEntries).toEqual([]);
  expect(log.pendingEntries.map((entry) => entry.kind)).toEqual([
    "tool",
    "tool",
    "assistant-block",
  ]);

  log = applyToolEnd(log, { id: "task1", result: "core 分析报告", isError: false });
  expect(
    log.staticEntries.map((entry) =>
      entry.kind === "tool"
        ? `tool:${entry.id}`
        : entry.kind === "assistant-block"
          ? `assistant-block:${entry.depth}`
          : entry.kind,
    ),
  ).toEqual(["tool:task1", "tool:read1", "assistant-block:1"]);
  expect(log.pendingEntries).toEqual([]);
});

test("嵌套工具：已完成的子条目在 pending 区保留结果，圆点可显示为完成态", () => {
  let log = appendToolStart(createDisplayLog(), { id: "task1", toolName: "task", input: {}, depth: 0 });
  log = appendToolStart(log, { id: "b1", toolName: "bash", input: { command: "ls" }, depth: 1 });
  log = applyToolEnd(log, { id: "b1", result: "ok", isError: false });
  expect(log.pendingEntries.map((entry) => entry.id)).toEqual(["task1", "b1"]);
  expect(log.pendingEntries[0]).not.toHaveProperty("result");
  expect(log.pendingEntries[1]).toMatchObject({ id: "b1", result: "ok", isError: false });
});

test("父先完成、子后完成时不丢条目，父仍排在子之前", () => {
  let log = appendToolStart(createDisplayLog(), { id: "task1", toolName: "task", input: {}, depth: 0 });
  log = appendToolStart(log, { id: "b1", toolName: "bash", input: {}, depth: 1 });
  log = applyToolEnd(log, { id: "task1", result: "结论", isError: false });
  expect(log.staticEntries.map((entry) => entry.id)).toEqual(["task1"]);
  log = applyToolEnd(log, { id: "b1", result: "ok", isError: false });
  expect(log.staticEntries.map((entry) => entry.id)).toEqual(["task1", "b1"]);
  expect(log.pendingEntries).toEqual([]);
});

test("applyToolEnd 找不到匹配 id 时原样返回", () => {
  const log = appendToolStart(createDisplayLog(), { id: "t1", toolName: "bash", input: {}, depth: 0 });
  expect(applyToolEnd(log, { id: "missing", result: "ok", isError: false })).toBe(log);
});

test("appendAssistantMessage 内部走 markdown 解析，展开成多条 assistant-block", () => {
  const log = appendAssistantMessage(createDisplayLog(), {
    text: "# 标题\n\n正文段落",
    depth: 1,
  });
  expect(log.staticEntries).toHaveLength(2);
  expect(log.staticEntries[0]).toMatchObject({
    kind: "assistant-block",
    depth: 1,
    block: { kind: "heading", level: 1 },
  });
  expect(log.staticEntries[1]).toMatchObject({
    kind: "assistant-block",
    depth: 1,
    block: { kind: "paragraph" },
  });
});

test("appendAssistantBlocks 直接追加已解析的块", () => {
  const blocks = [{ kind: "rule" as const }];
  const log = appendAssistantBlocks(createDisplayLog(), { blocks, depth: 0 });
  expect(log.staticEntries).toMatchObject([
    { kind: "assistant-block", depth: 0, block: { kind: "rule" } },
  ]);
});

test("setStreamingBlocks 替换 streamingBlocks 字段，不影响 staticEntries", () => {
  const blocks = [{ kind: "rule" as const }];
  const log = setStreamingBlocks(createDisplayLog(), blocks);
  expect(log.streamingBlocks).toEqual(blocks);
  expect(log.staticEntries).toEqual([]);
});
