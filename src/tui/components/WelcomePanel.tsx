import { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";

const BREAKPOINT_COLUMNS = 80;
const ACCENT_COLOR = "#e38c8f";

export interface WelcomePanelProps {
  workingDirectory: string;
  model: string;
}

export function isNarrowTerminal(columns: number | undefined): boolean {
  return (columns || BREAKPOINT_COLUMNS) < BREAKPOINT_COLUMNS;
}

export function WelcomePanel({
  workingDirectory,
  model,
}: WelcomePanelProps): JSX.Element {
  const { stdout } = useStdout();
  const [columns, setColumns] = useState(stdout.columns || BREAKPOINT_COLUMNS);

  useEffect(() => {
    const handleResize = (): void => {
      setColumns(stdout.columns || BREAKPOINT_COLUMNS);
    };
    stdout.on("resize", handleResize);
    return () => {
      stdout.off("resize", handleResize);
    };
  }, [stdout]);

  const narrow = isNarrowTerminal(columns);

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={ACCENT_COLOR}
      paddingX={1}
    >
      <Text color={ACCENT_COLOR} bold>
        mini-cc
      </Text>
      <Box flexDirection={narrow ? "column" : "row"}>
        <Box flexDirection="column" flexGrow={1} alignItems="center" paddingX={1}>
          <Text bold>欢迎使用 mini-cc</Text>
          <Text color={ACCENT_COLOR}>{"  ▄██▄\n █ ▪▪ █\n  ▀██▀"}</Text>
          <Text dimColor wrap="truncate-middle">
            {model}
          </Text>
          <Text dimColor wrap="truncate-middle">
            {workingDirectory}
          </Text>
        </Box>
        <Box
          flexDirection="column"
          width={narrow ? undefined : 30}
          borderStyle="single"
          borderLeft={!narrow}
          borderTop={narrow}
          borderRight={false}
          borderBottom={false}
          paddingX={1}
        >
          <Text color={ACCENT_COLOR} bold>
            使用提示
          </Text>
          <Text>输入任务后按 Enter 提交</Text>
          <Text> </Text>
          <Text color={ACCENT_COLOR} bold>
            当前会话
          </Text>
          <Text dimColor>暂无活动</Text>
        </Box>
      </Box>
    </Box>
  );
}
