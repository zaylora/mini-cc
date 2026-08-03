import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAuditHook } from "@/hooks/builtins.js";

describe("内置 hooks", () => {
  let originalCwd: string;
  let workdir: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    workdir = await mkdtemp(join(tmpdir(), "mini-agent-hooks-"));
    process.chdir(workdir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(workdir, { recursive: true, force: true });
  });

  test("审计日志以 JSON Lines 记录每次工具调用", async () => {
    const hook = createAuditHook("audit.jsonl");
    await hook({ toolName: "read_file", input: { path: "README.md" } });

    const record = JSON.parse(await readFile("audit.jsonl", "utf8"));
    expect(record.toolName).toBe("read_file");
    expect(record.input).toEqual({ path: "README.md" });
    expect(record.timestamp).toBeString();
  });
});
