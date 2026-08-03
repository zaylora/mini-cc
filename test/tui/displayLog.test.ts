import { expect, test } from "bun:test";
import {
  appendAssistantMessage,
  appendSystemEntry,
  appendToolStart,
  appendUserEntry,
  applyToolEnd,
  createDisplayLog,
} from "@/tui/displayLog.js";

test("append* 依次追加到 staticEntries", () => {
  let log = appendUserEntry(createDisplayLog(), "你好");
  log = appendAssistantMessage(log, { text: "收到", depth: 0 });
  log = appendSystemEntry(log, "系统提示");
  expect(log.pendingEntries).toEqual([]);
  expect(log.staticEntries).toMatchObject([
    { kind: "user", text: "你好" },
    { kind: "assistant", text: "收到", depth: 0 },
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

test("applyToolEnd 找不到匹配 id 时原样返回", () => {
  const log = appendToolStart(createDisplayLog(), { id: "t1", toolName: "bash", input: {}, depth: 0 });
  expect(applyToolEnd(log, { id: "missing", result: "ok", isError: false })).toBe(log);
});
