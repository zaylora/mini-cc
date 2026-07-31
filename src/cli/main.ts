#!/usr/bin/env node

import { resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { render } from "ink";
import { createElement } from "react";
import { createDefaultHookBus } from "@/hooks/index.js";
import { scanSkills } from "@/tools/skill.js";
import { App } from "@/tui/App.js";

export function parseWorkingDirectory(args: string[]): string {
  const cwdIndex = args.indexOf("--cwd");
  if (cwdIndex === -1) return resolve(process.cwd());
  const directory = args[cwdIndex + 1];
  if (!directory) throw new Error("--cwd 后需要目录路径");
  return resolve(directory);
}

export function shouldUseTui(
  input: NodeJS.ReadStream,
  output: NodeJS.WriteStream,
): boolean {
  return Boolean(input.isTTY && output.isTTY);
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  const workingDirectory = parseWorkingDirectory(args);
  process.chdir(workingDirectory);

  if (!shouldUseTui(stdin, stdout)) {
    stdout.write("mini-agent 的交互式界面需要在终端（TTY）中运行。\n");
    process.exitCode = 1;
    return;
  }

  const skills = await scanSkills();
  const hooks = createDefaultHookBus();
  const { waitUntilExit } = render(
    createElement(App, { workingDirectory, hooks, skills }),
  );
  await waitUntilExit();
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
