import { Box, Text } from "ink";
import { CONTEXT_WINDOW_TOKENS } from "@/core/modelLimits.js";

export interface StatusBarProps {
  cwd: string;
  model: string;
  step: number;
  inputTokens: number;
  busy: boolean;
}

export function StatusBar({
  cwd,
  model,
  step,
  inputTokens,
  busy,
}: StatusBarProps): JSX.Element {
  return (
    <Box>
      <Text dimColor>
        {cwd} · {model} · step {step} · context {inputTokens.toLocaleString("en-US")} / {CONTEXT_WINDOW_TOKENS.toLocaleString("en-US")} tokens
      </Text>
      {busy ? <Text color="yellow"> 执行中…</Text> : null}
    </Box>
  );
}
