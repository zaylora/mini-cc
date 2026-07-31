import type { HookFn } from "@/hooks/bus.js";

const DENY_PATTERNS = ["rm -rf /", "sudo", "shutdown", "reboot", "mkfs", "dd if="];
const ASK_PATTERNS = ["rm ", "> /etc/", "chmod 777"];

export function createPermissionHook(): HookFn<"PreToolUse"> {
  return ({ toolName, input }) => {
    if (toolName !== "bash" || !isBashInput(input)) {
      return { action: "continue" };
    }

    const denied = DENY_PATTERNS.find((pattern) => input.command.includes(pattern));
    if (denied) {
      return { action: "block", reason: `权限被拒：命中禁止规则 ${denied}` };
    }
    if (ASK_PATTERNS.some((pattern) => input.command.includes(pattern))) {
      return {
        action: "ask",
        message: `检测到可能具有破坏性的命令：${input.command}`,
      };
    }
    return { action: "continue" };
  };
}

function isBashInput(input: unknown): input is { command: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { command?: unknown }).command === "string"
  );
}
