import { useState } from "react";
import { Box } from "ink";
import { getModelId } from "@/config.js";
import type { HookBus } from "@/hooks/bus.js";
import type { SkillRegistry } from "@/tools/skill.js";
import { ConfirmModal } from "@/tui/components/ConfirmModal.js";
import { InputBox } from "@/tui/components/InputBox.js";
import { MessageList } from "@/tui/components/MessageList.js";
import { StatusBar } from "@/tui/components/StatusBar.js";
import { TodoPanel } from "@/tui/components/TodoPanel.js";
import { useAgentSession } from "@/tui/hooks/useAgentSession.js";

export interface AppProps {
  workingDirectory: string;
  hooks: HookBus;
  skills: SkillRegistry;
}

export function App({ workingDirectory, hooks, skills }: AppProps): JSX.Element {
  const [input, setInput] = useState("");
  const {
    displayLog,
    todos,
    step,
    busy,
    pendingConfirm,
    submit,
    resolveConfirm,
  } = useAgentSession({ hooks, skills });

  const handleSubmit = async (text: string): Promise<void> => {
    const trimmed = text.trim();
    if (!trimmed || busy) return;
    setInput("");
    await submit(trimmed);
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
          request={{ message: pendingConfirm.message, respond: resolveConfirm }}
        />
      ) : (
        <InputBox value={input} onChange={setInput} onSubmit={handleSubmit} disabled={busy} />
      )}
      <StatusBar cwd={workingDirectory} model={getModelId()} step={step} busy={busy} />
    </Box>
  );
}
