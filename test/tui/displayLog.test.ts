import { expect, test } from "bun:test";
import {
  appendAssistantMessage,
  appendSystemEntry,
  appendToolStart,
  appendUserEntry,
  applyToolEnd,
  MAX_DISPLAY_ENTRIES,
  type DisplayEntry,
} from "@/tui/displayLog.js";

test("append* 依次追加条目", () => {
  let log = appendUserEntry([], "你好");
  log = appendAssistantMessage(log, { text: "收到", depth: 0 });
  log = appendSystemEntry(log, "系统提示");
  expect(log).toEqual([
    { kind: "user", text: "你好" },
    { kind: "assistant", text: "收到", depth: 0 },
    { kind: "system", text: "系统提示" },
  ]);
});

test("applyToolEnd 按 id 回填结果", () => {
  let log = appendToolStart([], { id: "t1", toolName: "bash", input: { command: "ls" }, depth: 0 });
  log = applyToolEnd(log, { id: "t1", result: "ok", isError: false });
  expect(log).toEqual([
    { kind: "tool", id: "t1", toolName: "bash", input: { command: "ls" }, depth: 0, result: "ok", isError: false },
  ]);
});

test("applyToolEnd 找不到匹配 id 时原样返回", () => {
  const log = appendToolStart([], { id: "t1", toolName: "bash", input: {}, depth: 0 });
  expect(applyToolEnd(log, { id: "missing", result: "ok", isError: false })).toBe(log);
});

test("超过 500 条时从头部丢弃", () => {
  let log: DisplayEntry[] = [];
  for (let i = 0; i < MAX_DISPLAY_ENTRIES + 10; i += 1) {
    log = appendUserEntry(log, `消息${i}`);
  }
  expect(log).toHaveLength(MAX_DISPLAY_ENTRIES);
  expect(log[0]).toEqual({ kind: "user", text: "消息10" });
  expect(log.at(-1)).toEqual({ kind: "user", text: `消息${MAX_DISPLAY_ENTRIES + 9}` });
});
