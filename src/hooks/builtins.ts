import { appendFile } from "node:fs/promises";
import type { HookFn } from "@/hooks/bus.js";
import { safePath } from "@/tools/fs.js";

export function createAuditHook(
  path = ".mini-agent-audit.jsonl",
): HookFn<"PreToolUse"> {
  return async ({ toolName, input }) => {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      toolName,
      input,
    });
    await appendFile(safePath(path), `${record}\n`, "utf8");
    return { action: "continue" };
  };
}

export function createWorkingDirectoryHook(): HookFn<"UserPromptSubmit"> {
  return () => ({
    action: "inject",
    context: `当前工作目录：${process.cwd()}`,
  });
}
