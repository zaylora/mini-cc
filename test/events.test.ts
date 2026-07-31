import { describe, expect, test } from "bun:test";
import { createAgentEvents } from "@/core/events.js";

describe("AgentEvents", () => {
  test("只按事件名分发对应 payload", () => {
    const events = createAgentEvents();
    const received: Array<{ event: string; payload: unknown }> = [];

    events.on("step-start", (payload) => {
      received.push({ event: "step-start", payload });
    });
    events.on("assistant-message", (payload) => {
      received.push({ event: "assistant-message", payload });
    });

    const payload = { text: "完成", depth: 1 };
    events.emit("assistant-message", payload);

    expect(received).toEqual([{ event: "assistant-message", payload }]);
  });

  test("同一事件的多个监听者按注册顺序同步调用", () => {
    const events = createAgentEvents();
    const calls: string[] = [];

    events.on("step-start", () => calls.push("first"));
    events.on("step-start", () => calls.push("second"));

    events.emit("step-start", { step: 1, depth: 0 });

    expect(calls).toEqual(["first", "second"]);
  });
});
