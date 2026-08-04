import type { HookFn } from "@/hooks/bus.js";

interface CommandRule {
  label: string; // 出现在拒绝原因里的可读规则名
  pattern: RegExp;
}

// 不分平台都危险：Windows 上也可能通过 wsl / git-bash / busybox 执行 Unix 命令
const COMMON_DENY: CommandRule[] = [
  { label: "sudo", pattern: /\bsudo\b/i },
  { label: "shutdown", pattern: /\bshutdown\b/i },
  { label: "reboot", pattern: /\breboot\b/i },
  {
    // rm 同时带 r 与 f 两个短选项（-rf / -fr / -r -f 均算），且目标是绝对路径或家目录
    label: "rm -rf /",
    pattern: /\brm\b(?=[^\n]*\s-[^\s-]*r)(?=[^\n]*\s-[^\s-]*f)[^\n]*\s[~/]/i,
  },
  { label: "mkfs", pattern: /\bmkfs(?:\.\w+)?\b/i },
  { label: "dd if=", pattern: /\bdd\b[^\n]*\bif=/i },
];

// rm 在 PowerShell 里是 Remove-Item 的内置别名，两个平台都要问
const COMMON_ASK: RegExp[] = [/\brm\b/i];

const POSIX_DENY: CommandRule[] = [
  { label: "写入块设备", pattern: />\s*\/dev\/(?:sd|nvme|disk|hd)/i },
];

const POSIX_ASK: RegExp[] = [
  /\bchmod\b[^\n]*\b777\b/i,
  />\s*\/etc\//i,
  /\bchown\b[^\n]*\s-\w*R/i,
];

const WIN32_DENY: CommandRule[] = [
  {
    // 删除目标直指盘符根，如 Remove-Item C:\ -Recurse -Force
    label: "Remove-Item <盘符根>",
    pattern: /\b(?:Remove-Item|ri|rd|rmdir|del|erase)\b[^\n]*\s[a-z]:[\\/]?(?=\s|$)/i,
  },
  { label: "Stop-Computer", pattern: /\bStop-Computer\b/i },
  { label: "Restart-Computer", pattern: /\bRestart-Computer\b/i },
  { label: "Format-Volume", pattern: /\bFormat-Volume\b/i },
  { label: "Clear-Disk", pattern: /\bClear-Disk\b/i },
  { label: "diskpart", pattern: /\bdiskpart\b/i },
  { label: "format <盘符>", pattern: /\bformat(?:\.com)?\s+[a-z]:/i },
  { label: "reg delete", pattern: /\breg(?:\.exe)?\s+delete\b/i },
];

const WIN32_ASK: RegExp[] = [
  /\bRemove-Item(?:Property)?\b/i,
  /\b(?:ri|rd|rmdir|del|erase)\b/i,
  /\bClear-Content\b/i,
  /\b(?:icacls|Set-Acl)\b/i,
  /\bStop-Process\b/i,
  /[a-z]:\\Windows\\/i,
];

export interface PermissionHookOptions {
  // bash 工具在 win32 上走 PowerShell、其余平台走 /bin/sh，规则表需要跟着切换
  platform?: NodeJS.Platform;
}

export function createPermissionHook(
  options: PermissionHookOptions = {},
): HookFn<"PreToolUse"> {
  const isWindows = (options.platform ?? process.platform) === "win32";
  const denyRules = [...COMMON_DENY, ...(isWindows ? WIN32_DENY : POSIX_DENY)];
  const askRules = [...COMMON_ASK, ...(isWindows ? WIN32_ASK : POSIX_ASK)];

  return ({ toolName, input }) => {
    if (toolName !== "bash" || !isBashInput(input)) {
      return { action: "continue" };
    }

    const denied = denyRules.find((rule) => rule.pattern.test(input.command));
    if (denied) {
      return { action: "block", reason: `权限被拒：命中禁止规则 ${denied.label}` };
    }
    if (askRules.some((pattern) => pattern.test(input.command))) {
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
