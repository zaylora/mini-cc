import { useEffect, useRef, useState } from "react";
import { Box } from "ink";
import { getModelId } from "@/config.js";
import { createAgentEvents } from "@/core/events.js";
import { agentLoop, MaxStepsExceededError } from "@/core/loop.js";
import { createState, type State, type Todo } from "@/core/state.js";
import type { HookBus } from "@/hooks/bus.js";
import type { MarkdownBlock } from "@/markdown/blocks.js";
import type { SkillRegistry } from "@/tools/skill.js";
import { ConfirmModal } from "@/tui/ConfirmModal.js";
import { createConfirmBridge, type ConfirmRequest } from "@/tui/confirmBridge.js";
import {
  appendAssistantBlocks,
  appendAssistantMessage,
  appendSystemEntry,
  appendToolStart,
  appendUserEntry,
  applyToolEnd,
  createDisplayLog,
  setStreamingBlocks,
  type DisplayLog,
} from "@/tui/displayLog.js";
import { InputBox } from "@/tui/InputBox.js";
import { MessageList } from "@/tui/MessageList.js";
import { StatusBar } from "@/tui/StatusBar.js";
import {
  createStreamBuffer,
  flush as flushStreamBuffer,
  pushDelta,
  type StreamBuffer,
} from "@/tui/streamBuffer.js";
import { TodoPanel } from "@/tui/TodoPanel.js";

export interface AppProps {
  workingDirectory: string;
  hooks: HookBus;
  skills: SkillRegistry;
}

export function App({ workingDirectory, hooks, skills }: AppProps): JSX.Element {
  const stateRef = useRef<State>();
  if (!stateRef.current) stateRef.current = createState();
  const eventsRef = useRef(createAgentEvents());
  const confirmBridgeRef = useRef(createConfirmBridge());
  const streamBufferRef = useRef<StreamBuffer>(createStreamBuffer());
  const latestTailRef = useRef<MarkdownBlock[]>([]);
  const throttleTimerRef = useRef<ReturnType<typeof setInterval> | undefined>();

  const [displayLog, setDisplayLog] = useState<DisplayLog>(createDisplayLog);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | undefined>();

  const commitStreamBuffer = (): void => {
    const { buffer, committed } = flushStreamBuffer(streamBufferRef.current);
    streamBufferRef.current = buffer;
    if (committed.length > 0) {
      setDisplayLog((log) => appendAssistantBlocks(log, { blocks: committed, depth: 0 }));
    }
    setDisplayLog((log) => setStreamingBlocks(log, []));
  };

  useEffect(() => {
    const events = eventsRef.current;
    events.on("step-start", ({ step: nextStep }) => setStep(nextStep));
    events.on("assistant-message", ({ text, depth }) =>
      setDisplayLog((log) => appendAssistantMessage(log, { text, depth })),
    );
    events.on("assistant-delta", ({ text }) => {
      const { buffer, committed, tail } = pushDelta(streamBufferRef.current, text);
      streamBufferRef.current = buffer;
      latestTailRef.current = tail;
      if (committed.length > 0) {
        setDisplayLog((log) => appendAssistantBlocks(log, { blocks: committed, depth: 0 }));
      }
      if (throttleTimerRef.current === undefined) {
        throttleTimerRef.current = setInterval(() => {
          setDisplayLog((log) => setStreamingBlocks(log, latestTailRef.current));
        }, 32);
      }
    });
    events.on("assistant-flush", () => {
      if (throttleTimerRef.current !== undefined) {
        clearInterval(throttleTimerRef.current);
        throttleTimerRef.current = undefined;
      }
      commitStreamBuffer();
    });
    events.on("stream-interrupted", ({ reason }) => {
      if (throttleTimerRef.current !== undefined) {
        clearInterval(throttleTimerRef.current);
        throttleTimerRef.current = undefined;
      }
      commitStreamBuffer();
      setDisplayLog((log) =>
        appendSystemEntry(log, `连接中断（${reason}），正在重新生成…`),
      );
    });
    events.on("tool-start", (payload) => setDisplayLog((log) => appendToolStart(log, payload)));
    events.on("tool-end", (payload) => setDisplayLog((log) => applyToolEnd(log, payload)));
    events.on("todo-changed", ({ todos: nextTodos }) => setTodos(nextTodos));
    confirmBridgeRef.current.subscribe((request) => setPendingConfirm(request));
  }, []);

  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    setDisplayLog((log) => appendUserEntry(log, trimmed));
    setBusy(true);

    const state = stateRef.current!;
    const promptHook = await hooks.trigger("UserPromptSubmit", { prompt: trimmed });
    const content =
      promptHook.action === "inject" ? `${trimmed}\n${promptHook.context}` : trimmed;
    state.messages.push({ role: "user", content });

    try {
      await agentLoop(state, {
        hooks,
        skills,
        events: eventsRef.current,
        confirm: confirmBridgeRef.current.confirm,
      });
    } catch (error) {
      const message =
        error instanceof MaxStepsExceededError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      setDisplayLog((log) => appendSystemEntry(log, message));
    } finally {
      if (throttleTimerRef.current !== undefined) {
        clearInterval(throttleTimerRef.current);
        throttleTimerRef.current = undefined;
      }
      setBusy(false);
    }
  };

  const handleConfirmResolve = (value: boolean): void => {
    pendingConfirm?.respond(value);
    setPendingConfirm(undefined);
  };

  return (
    <Box flexDirection="column">
      <MessageList
        staticEntries={displayLog.staticEntries}
        pendingEntries={displayLog.pendingEntries}
        streamingBlocks={displayLog.streamingBlocks}
      />
      <TodoPanel todos={todos} />
      {pendingConfirm ? (
        <ConfirmModal
          request={{ message: pendingConfirm.message, respond: handleConfirmResolve }}
        />
      ) : (
        <InputBox value={input} onChange={setInput} onSubmit={handleSubmit} disabled={busy} />
      )}
      <StatusBar cwd={workingDirectory} model={getModelId()} step={step} busy={busy} />
    </Box>
  );
}
