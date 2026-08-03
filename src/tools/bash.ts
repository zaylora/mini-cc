import { spawn, spawnSync } from "node:child_process";

const DEFAULT_TIMEOUT_MS = 120_000;

export async function runBash(
  input: unknown,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  if (!isCommandInput(input)) {
    throw new Error("bash 工具需要字符串 command");
  }

  const command =
    process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", input.command]
      : ["/bin/sh", "-c", input.command];
  const { stdout, stderr, exitCode } = await runCommand(
    command[0],
    command.slice(1),
    timeoutMs,
  );

  const parts = [];
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  parts.push(`exit_code: ${exitCode}`);
  return parts.join("\n");
}

function runCommand(
  executable: string,
  args: string[],
  timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: process.cwd(),
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
        reject(new Error(`bash 命令执行超时（${timeoutMs}ms），已终止进程`));
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
    // The process may have exited between the timeout and the kill attempt.
  }
}

function isCommandInput(input: unknown): input is { command: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { command?: unknown }).command === "string"
  );
}
