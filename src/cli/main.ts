#!/usr/bin/env node

import { createInterface } from "node:readline/promises";
import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { renderLastAssistantMessage } from "@/cli/render.js";
import { agentLoop, MaxStepsExceededError } from "@/core/loop.js";
import { createState } from "@/core/state.js";
import { createDefaultHookBus } from "@/hooks/index.js";

export function parseWorkingDirectory(args: string[]): string {
  const cwdIndex = args.indexOf("--cwd");
  if (cwdIndex === -1) return resolve(process.cwd());
  const directory = args[cwdIndex + 1];
  if (!directory) throw new Error("--cwd 后需要目录路径");
  return resolve(directory);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const workingDirectory = parseWorkingDirectory(args);
  process.chdir(workingDirectory);

  const state = createState();
  const readline = createInterface({ input: stdin, output: stdout });
  const hooks = createDefaultHookBus();
  try {
    readline.setPrompt("> ");
    readline.prompt();
    for await (const inputLine of readline) {
      const line = inputLine.trim();
      if (!line) {
        readline.prompt();
        continue;
      }

      const promptHook = await hooks.trigger("UserPromptSubmit", { prompt: line });
      const content =
        promptHook.action === "inject" ? `${line}\n${promptHook.context}` : line;
      state.messages.push({ role: "user", content });
      try {
        await agentLoop(state, {
          hooks,
          confirm: async (message) => {
            const answer = await readline.question(`${message}\n允许执行？[y/N] `);
            return answer.trim().toLowerCase() === "y" || answer.trim().toLowerCase() === "yes";
          },
        });
        stdout.write(`${renderLastAssistantMessage(state.messages)}\n`);
      } catch (error) {
        if (error instanceof MaxStepsExceededError) {
          stdout.write(`${error.message}\n`);
          readline.prompt();
          continue;
        }
        throw error;
      }
      readline.prompt();
    }
  } finally {
    readline.close();
  }
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
