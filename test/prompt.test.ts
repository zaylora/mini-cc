import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "@/core/state.js";
import { createPromptAssembler } from "@/prompt/assembler.js";
import type { SkillRegistry } from "@/tools/skill.js";

describe("PromptAssembler", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  test("按真实工具、工作目录、技能和记忆状态组装", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-prompt-"));
    directories.push(root);
    await writeFile(join(root, "MEMORY.md"), "只保留已确认事实", "utf8");
    const skills: SkillRegistry = new Map([
      ["review", { name: "review", description: "审查风险", content: "正文" }],
    ]);
    const state = createState();
    state.workspace = root;
    state.enabledTools = ["read_file", "load_skill"];
    state.memoryPath = join(root, "MEMORY.md");
    const assembler = createPromptAssembler(skills);

    const prompt = await assembler.get(state);

    expect(prompt).toContain(root);
    expect(prompt).toContain("read_file, load_skill");
    expect(prompt).toContain("review: 审查风险");
    expect(prompt).not.toContain("正文");
    expect(prompt).toContain("只保留已确认事实");
  });

  test("状态未变时复用缓存，记忆变化后重新组装", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-prompt-cache-"));
    directories.push(root);
    const memoryPath = join(root, "MEMORY.md");
    await writeFile(memoryPath, "版本一", "utf8");
    const state = createState();
    state.memoryPath = memoryPath;
    const assembler = createPromptAssembler(new Map());

    const first = await assembler.get(state);
    const second = await assembler.get(state);
    await writeFile(memoryPath, "版本二", "utf8");
    const third = await assembler.get(state);

    expect(second).toBe(first);
    expect(third).toContain("版本二");
    expect(third).not.toBe(first);
  });

  test("Windows 下说明 bash 工具实际使用 PowerShell", async () => {
    const state = createState();
    state.enabledTools = ["bash"];
    const assembler = createPromptAssembler(new Map());

    const prompt = await assembler.get(state);

    if (process.platform === "win32") {
      expect(prompt).toContain("Windows PowerShell");
      expect(prompt).toContain("不要嵌套调用 powershell");
    }
  });
});
