import { Box, Text } from "ink";
import TextInput from "ink-text-input";

export interface InputBoxProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}

export function InputBox({ value, onChange, onSubmit, disabled }: InputBoxProps): JSX.Element {
  return (
    <Box
      borderStyle="single"
      borderLeft={false}
      borderRight={false}
      paddingX={1}
    >
      {disabled ? (
        <Text dimColor>请稍候…</Text>
      ) : (
        <>
          <Text color="#e38c8f">{"> "}</Text>
          <TextInput
            value={value}
            placeholder="输入任务..."
            onChange={onChange}
            onSubmit={onSubmit}
          />
        </>
      )}
    </Box>
  );
}
