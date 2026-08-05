import { expect, test } from "bun:test";
import { createAgentEvents } from "@/core/events.js";
import { agentLoop } from "@/core/loop.js";
import { createState } from "@/core/state.js";
import {
  appendAssistantMessage,
  appendToolStart,
  applyToolEnd,
  createDisplayLog,
  type DisplayEntry,
  type DisplayLog,
} from "@/tui/model/displayLog.js";
import { createStreamingModelServer, useTestModel } from "./modelServer.js";

type ToolEntry = Extract<DisplayEntry, { kind: "tool" }>;

const isToolEntry = (entry: DisplayEntry): entry is ToolEntry => entry.kind === "tool";

test("真实 agentLoop 时序下，子 Agent 的工具和结论排在父 task 条目之后", async () => {
  const command =
    process.platform === "win32" ? "Write-Output sub-ok" : "printf sub-ok";
  const server = createStreamingModelServer([
    // 主 Agent 第 1 步：派子代理
    {
      deltas: [],
      stopReason: "tool_use",
      toolUse: { id: "task-1", name: "task", input: { description: "分析 src/core" } },
    },
    // 子 Agent 第 1 步：调用 bash（会先于父 task 完成）
    {
      deltas: [],
      stopReason: "tool_use",
      toolUse: { id: "bash-1", name: "bash", input: { command } },
    },
    // 子 Agent 第 2 步：给出结论并结束
    { deltas: ["子结论"], stopReason: "end_turn" },
    // 主 Agent 第 2 步：结束
    { deltas: ["完成"], stopReason: "end_turn" },
  ]);
  const restore = useTestModel(server.url.origin);
  const events = createAgentEvents();

  let log: DisplayLog = createDisplayLog();
  events.on("tool-start", (payload) => {
    log = appendToolStart(log, payload);
  });
  events.on("tool-end", (payload) => {
    log = applyToolEnd(log, payload);
  });
  events.on("assistant-message", (payload) => {
    log = appendAssistantMessage(log, payload);
  });

  try {
    const state = createState();
    state.messages.push({ role: "user", content: "派子代理分析 core" });
    await agentLoop(state, { events });
  } finally {
    restore();
    server.stop(true);
  }

  const tools = log.staticEntries.filter(isToolEntry);
  expect(tools.map((entry) => entry.id)).toEqual(["task-1", "bash-1"]);
  expect(tools.map((entry) => entry.depth)).toEqual([0, 1]);
  expect(
    log.staticEntries.map((entry) =>
      entry.kind === "tool"
        ? `tool:${entry.id}`
        : entry.kind === "assistant-block"
          ? `assistant-block:${entry.depth}`
          : entry.kind,
    ),
  ).toEqual(["tool:task-1", "tool:bash-1", "assistant-block:1"]);
  expect(log.pendingEntries).toEqual([]);
});
