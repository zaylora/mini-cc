import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { spawn } from "node:child_process";

type Handler = (input: unknown) => Promise<string>;

export const TOOLS: Tool[] = [
  {
    name: "bash",
    description:
      "Execute a shell command in the current working directory and return stdout, stderr, and the exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
];

const TOOL_HANDLERS: Record<string, Handler> = {
  bash: runBash,
};

export async function dispatch(name: string, input: unknown): Promise<string> {
  const handler = TOOL_HANDLERS[name];
  if (!handler) {
    throw new Error(`未知工具: ${name}`);
  }

  return handler(input);
}

async function runBash(input: unknown): Promise<string> {
  if (!isCommandInput(input)) {
    throw new Error("bash 工具需要字符串 command");
  }

  const command =
    process.platform === "win32"
      ? ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", input.command]
      : ["/bin/sh", "-c", input.command];
  const { stdout, stderr, exitCode } = await runCommand(command[0], command.slice(1));

  const parts = [];
  if (stdout.trim()) parts.push(`stdout:\n${stdout.trimEnd()}`);
  if (stderr.trim()) parts.push(`stderr:\n${stderr.trimEnd()}`);
  parts.push(`exit_code: ${exitCode}`);
  return parts.join("\n");
}

function runCommand(
  executable: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: process.cwd() });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ stdout, stderr, exitCode: code ?? 1 }));
  });
}

function isCommandInput(input: unknown): input is { command: string } {
  return (
    typeof input === "object" &&
    input !== null &&
    typeof (input as { command?: unknown }).command === "string"
  );
}
