import { useState } from "react";
import { Box, Text, useInput } from "ink";
import type { ConfirmRequest } from "@/tui/services/confirmBridge.js";

export interface ConfirmModalProps {
  request: ConfirmRequest;
}

export function ConfirmModal({ request }: ConfirmModalProps): JSX.Element {
  const [selected, setSelected] = useState<"allow" | "deny">("allow");

  useInput((input, key) => {
    if (input.toLowerCase() === "y") {
      request.respond(true);
      return;
    }
    if (input.toLowerCase() === "n") {
      request.respond(false);
      return;
    }
    if (key.leftArrow || key.rightArrow || key.upArrow || key.downArrow) {
      setSelected((current) => (current === "allow" ? "deny" : "allow"));
      return;
    }
    if (key.return) {
      request.respond(selected === "allow");
      return;
    }
    if (key.escape) {
      request.respond(false);
    }
  });

  return (
    <Box borderStyle="round" flexDirection="column" paddingX={1}>
      <Text>{request.message}</Text>
      <Text>
        <Text color={selected === "allow" ? "green" : undefined} bold={selected === "allow"}>
          {selected === "allow" ? "> 允许" : "  允许"}
        </Text>
        {"  "}
        <Text color={selected === "deny" ? "red" : undefined} bold={selected === "deny"}>
          {selected === "deny" ? "> 拒绝" : "  拒绝"}
        </Text>
      </Text>
      <Text dimColor>[y] 允许 · [n] 拒绝 · ←/→ 切换 · Enter 确认</Text>
    </Box>
  );
}
