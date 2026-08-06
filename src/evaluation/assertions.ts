import { spawn, spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import type {
  AssertionContext,
  AssertionResult,
  AssertionSpec,
} from "@/evaluation/types.js";
import { resolveWorkspacePath } from "@/evaluation/workspace.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

export async function evaluateAssertions(
  workspace: string,
  context: AssertionContext,
  assertions: AssertionSpec[],
  commandTimeoutMs = DEFAULT_COMMAND_TIMEOUT_MS,
): Promise<AssertionResult[]> {
  const results: AssertionResult[] = [];
  for (const spec of assertions) {
    const startedAt = performance.now();
    try {
      const outcome = await evaluateAssertion(
        workspace,
        context,
        spec,
        commandTimeoutMs,
      );
      results.push({
        spec,
        ...outcome,
        durationMs: Math.max(0, performance.now() - startedAt),
      });
    } catch (error) {
      results.push({
        spec,
        passed: false,
        message: errorMessage(error),
        durationMs: Math.max(0, performance.now() - startedAt),
      });
    }
  }
  return results;
}

async function evaluateAssertion(
  workspace: string,
  context: AssertionContext,
  spec: AssertionSpec,
  commandTimeoutMs: number,
): Promise<Pick<AssertionResult, "passed" | "message" | "actual">> {
  switch (spec.type) {
    case "file_exists": {
      const target = resolveWorkspacePath(workspace, spec.path);
      await access(target);
      return { passed: true, message: `文件存在：${spec.path}` };
    }
    case "file_not_exists": {
      const target = resolveWorkspacePath(workspace, spec.path);
      const exists = await access(target).then(() => true, () => false);
      return {
        passed: !exists,
        message: exists
          ? `文件不应存在但存在：${spec.path}`
          : `文件确实不存在：${spec.path}`,
      };
    }
    case "file_contains": {
      const target = resolveWorkspacePath(workspace, spec.path);
      const content = await readFile(target, "utf8");
      return {
        passed: content.includes(spec.text),
        message: content.includes(spec.text)
          ? `文件包含目标文本：${spec.path}`
          : `文件不包含目标文本：${spec.path}`,
        actual: content,
      };
    }
    case "file_not_contains": {
      const target = resolveWorkspacePath(workspace, spec.path);
      const content = await readFile(target, "utf8");
      return {
        passed: !content.includes(spec.text),
        message: content.includes(spec.text)
          ? `文件包含了不应出现的文本：${spec.path}`
          : `文件未包含不应出现的文本：${spec.path}`,
        actual: content,
      };
    }
    case "command_succeeds": {
      const result = await runCommand(spec.command, workspace, commandTimeoutMs);
      return {
        passed: result.exitCode === 0,
        message: result.exitCode === 0
          ? `命令执行成功：${spec.command}`
          : `命令执行失败（exit ${result.exitCode}）：${spec.command}`,
        actual: result,
      };
    }
    case "final_contains": {
      const passed = context.finalOutput.includes(spec.text);
      return {
        passed,
        message: passed ? "最终输出包含目标文本" : "最终输出缺少目标文本",
        actual: context.finalOutput,
      };
    }
    case "final_not_contains": {
      const passed = !context.finalOutput.includes(spec.text);
      return {
        passed,
        message: passed ? "最终输出未包含不应出现的文本" : "最终输出包含了不应出现的文本",
        actual: context.finalOutput,
      };
    }
    case "todos_completed": {
      const passed = context.todos.length > 0 &&
        context.todos.every((todo) => todo.status === "completed");
      return {
        passed,
        message: passed ? "所有 Todo 已完成" : "存在未完成的 Todo 或 Todo 为空",
        actual: context.todos,
      };
    }
  }
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

function runCommand(
  command: string,
  cwd: string,
  timeoutMs: number,
): Promise<CommandResult> {
  const [executable, ...args] = process.platform === "win32"
    ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command]
    : ["/bin/sh", "-c", command];

  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd,
      detached: process.platform !== "win32",
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcessTree(child.pid);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (timedOut) {
        reject(new Error(`断言命令执行超时（${timeoutMs}ms）：${command}`));
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

function terminateProcessTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawnSync("taskkill.exe", ["/PID", String(pid), "/T", "/F"], {
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // 进程可能已在超时处理期间退出。
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
