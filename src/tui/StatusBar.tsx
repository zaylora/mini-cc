import { Box, Text } from "ink";

export interface StatusBarProps {
  cwd: string;
  model: string;
  step: number;
  busy: boolean;
}

export function StatusBar({ cwd, model, step, busy }: StatusBarProps): JSX.Element {
  return (
    <Box>
      <Text dimColor>
        {cwd} · {model} · step {step}
      </Text>
      {busy ? <Text color="yellow"> 执行中…</Text> : null}
    </Box>
  );
}
