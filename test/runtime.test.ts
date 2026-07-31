import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentLoop } from "@/core/loop.js";
import { createRuntimeTools } from "@/core/runtime.js";
import { createState } from "@/core/state.js";
import { HookBus } from "@/hooks/bus.js";
import { scanSkills } from "@/tools/skill.js";

describe("v4 runtime", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  test("core runtime 为子 Agent 移除 task 工具", () => {
    const runtime = createRuntimeTools({
      state: createState(1),
      skills: new Map(),
      spawnSubagent: async () => "不会执行",
    });

    expect(runtime.definitions.some((tool) => tool.name === "task")).toBe(false);
  });

  test("技能目录进入 system，正文只由 load_skill 返回", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-runtime-skills-"));
    directories.push(root);
    const skillDirectory = join(root, "review");
    await mkdir(skillDirectory);
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      [
        "---",
        "name: review",
        "description: 审查代码风险",
        "---",
        "正文中的秘密规范",
      ].join("\n"),
    );
    const skills = await scanSkills(root);
    const requests: ModelRequest[] = [];
    const server = createModelServer(requests, [
      [{ type: "tool_use", id: "skill", name: "load_skill", input: { name: "review" } }],
      [{ type: "text", text: "已加载" }],
    ]);
    const restore = useTestModel(server.url.origin);

    try {
      const state = createState();
      state.messages.push({ role: "user", content: "按规范审查" });
      await agentLoop(state, { skills });

      expect(requests[0]?.system).toContain("review: 审查代码风险");
      expect(requests[0]?.system).not.toContain("正文中的秘密规范");
      expect(JSON.stringify(requests[1]?.messages)).toContain("正文中的秘密规范");
      expect(requests[0]?.tools.map((tool) => tool.name)).toEqual([
        "bash",
        "read_file",
        "write_file",
        "edit_file",
        "glob",
        "todo_write",
        "task",
        "load_skill",
      ]);
    } finally {
      restore();
      server.stop(true);
    }
  });

  test("task 使用隔离 State、受限工具并复用父 hooks", async () => {
    const requests: ModelRequest[] = [];
    const command = process.platform === "win32" ? "Write-Output child-ok" : "printf child-ok";
    const server = createModelServer(requests, [
      [{ type: "tool_use", id: "parent-task", name: "task", input: { description: "检查子任务" } }],
      [{ type: "tool_use", id: "child-bash", name: "bash", input: { command } }],
      [{ type: "text", text: "子任务结论" }],
      [{ type: "text", text: "父任务完成" }],
    ]);
    const restore = useTestModel(server.url.origin);
    const hooks = new HookBus();
    const calls: string[] = [];
    hooks.register("PreToolUse", ({ toolName }) => {
      calls.push(toolName);
      return { action: "continue" };
    });

    try {
      const state = createState();
      state.messages.push({ role: "user", content: "父级私密上下文" });
      await agentLoop(state, { hooks });

      expect(requests).toHaveLength(4);
      expect(JSON.stringify(requests[1]?.messages)).toContain("检查子任务");
      expect(JSON.stringify(requests[1]?.messages)).not.toContain("父级私密上下文");
      expect(requests[1]?.tools.some((tool) => tool.name === "task")).toBe(false);
      expect(requests[1]?.tools.some((tool) => tool.name === "todo_write")).toBe(true);
      expect(calls).toEqual(["task", "bash"]);

      const parentFollowUp = JSON.stringify(requests[3]?.messages);
      expect(parentFollowUp).toContain("子任务结论");
      expect(parentFollowUp).not.toContain("child-ok");
      expect(state.depth).toBe(0);
      expect(state.messages.at(-1)).toEqual({
        role: "assistant",
        content: [{ type: "text", text: "父任务完成" }],
      });
    } finally {
      restore();
      server.stop(true);
    }
  });
});

interface ModelRequest {
  system: string;
  messages: unknown[];
  tools: Array<{ name: string }>;
}

function createModelServer(
  requests: ModelRequest[],
  responses: unknown[][],
): ReturnType<typeof Bun.serve> {
  let index = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push(await request.json());
      const content = responses[index++] ?? responses.at(-1) ?? [];
      const usesTool = content.some(
        (block) => typeof block === "object" && block !== null && (block as { type?: string }).type === "tool_use",
      );
      return Response.json({
        id: `message-${index}`,
        type: "message",
        role: "assistant",
        model: "test-model",
        content,
        stop_reason: usesTool ? "tool_use" : "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      });
    },
  });
}

function useTestModel(baseUrl: string): () => void {
  const previous = [process.env.API_KEY, process.env.BASE_URL, process.env.MODEL_ID];
  process.env.API_KEY = "test-key";
  process.env.BASE_URL = baseUrl;
  process.env.MODEL_ID = "test-model";
  return () => {
    restoreEnvironment("API_KEY", previous[0]);
    restoreEnvironment("BASE_URL", previous[1]);
    restoreEnvironment("MODEL_ID", previous[2]);
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
