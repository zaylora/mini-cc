import { useEffect, useRef, useState } from "react";
import { Box } from "ink";
import { getModelId } from "@/config.js";
import { createAgentEvents } from "@/core/events.js";
import { agentLoop, MaxStepsExceededError } from "@/core/loop.js";
import { createState, type State, type Todo } from "@/core/state.js";
import type { HookBus } from "@/hooks/bus.js";
import type { SkillRegistry } from "@/tools/skill.js";
import { ConfirmModal } from "@/tui/ConfirmModal.js";
import { createConfirmBridge, type ConfirmRequest } from "@/tui/confirmBridge.js";
import {
  appendAssistantMessage,
  appendSystemEntry,
  appendToolStart,
  appendUserEntry,
  applyToolEnd,
  type DisplayEntry,
} from "@/tui/displayLog.js";
import { InputBox } from "@/tui/InputBox.js";
import { MessageList } from "@/tui/MessageList.js";
import { StatusBar } from "@/tui/StatusBar.js";
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

  const [entries, setEntries] = useState<DisplayEntry[]>([]);
  const [todos, setTodos] = useState<Todo[]>([]);
  const [step, setStep] = useState(0);
  const [busy, setBusy] = useState(false);
  const [input, setInput] = useState("");
  const [pendingConfirm, setPendingConfirm] = useState<ConfirmRequest | undefined>();

  useEffect(() => {
    const events = eventsRef.current;
    events.on("step-start", ({ step: nextStep }) => setStep(nextStep));
    events.on("assistant-message", ({ text, depth }) =>
      setEntries((log) => appendAssistantMessage(log, { text, depth })),
    );
    events.on("tool-start", (payload) => setEntries((log) => appendToolStart(log, payload)));
    events.on("tool-end", (payload) => setEntries((log) => applyToolEnd(log, payload)));
    events.on("todo-changed", ({ todos: nextTodos }) => setTodos(nextTodos));
    confirmBridgeRef.current.subscribe((request) => setPendingConfirm(request));
  }, []);

  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    setEntries((log) => appendUserEntry(log, trimmed));
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
      setEntries((log) => appendSystemEntry(log, message));
    } finally {
      setBusy(false);
    }
  };

  const handleConfirmResolve = (value: boolean): void => {
    pendingConfirm?.respond(value);
    setPendingConfirm(undefined);
  };

  return (
    <Box flexDirection="column">
      <MessageList entries={entries} />
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
