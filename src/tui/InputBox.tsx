import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function InputBox({ value, onChange, onSubmit, disabled }: InputBoxProps): JSX.Element {
  if (disabled) {
    return (
      <Box>
        <Text dimColor>请稍候…</Text>
      </Box>
    );
  }

  return (
    <Box>
      <Text>{"> "}</Text>
      <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
    </Box>
  );
}
