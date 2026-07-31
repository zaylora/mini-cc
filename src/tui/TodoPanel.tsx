import { Box, Text } from "ink";
import type { Todo } from "@/core/state.js";
import { STATUS_MARKS } from "@/tools/todo.js";

export interface TodoPanelProps {
  todos: Todo[];
}

export function TodoPanel({ todos }: TodoPanelProps): JSX.Element | null {
  if (todos.length === 0) return null;

  return (
    <Box flexDirection="column" borderStyle="round" paddingX={1}>
      {todos.map((todo, index) => (
        <Text key={`${index}-${todo.content}`}>
          [{STATUS_MARKS[todo.status]}] {todo.content}
        </Text>
      ))}
    </Box>
  );
}
