import { appendFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { HookFn } from "@/hooks/bus.js";
import { safePath } from "@/tools/fs.js";

export function createAuditHook(
  path = join(".minicc", "mini-agent-audit.jsonl"),
): HookFn<"PreToolUse"> {
  return async ({ toolName, input }) => {
    const record = JSON.stringify({
      timestamp: new Date().toISOString(),
      toolName,
      input,
    });
    const target = safePath(path);
    await mkdir(dirname(target), { recursive: true });
    await appendFile(target, `${record}\n`, "utf8");
    return { action: "continue" };
  };
}

export function createWorkingDirectoryHook(): HookFn<"UserPromptSubmit"> {
  return () => ({
    action: "inject",
    context: `当前工作目录：${process.cwd()}`,
  });
}
