import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSkillCatalog,
  loadSkill,
  scanSkills,
} from "@/tools/skill.js";

describe("技能加载", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.splice(0).map((directory) =>
        rm(directory, { recursive: true, force: true }),
      ),
    );
  });

  test("目录只暴露元数据，正文通过 load_skill 按需返回", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-skills-"));
    directories.push(root);
    const skillDirectory = join(root, "testing");
    await mkdir(skillDirectory);
    await writeFile(
      join(skillDirectory, "SKILL.md"),
      [
        "---",
        "name: testing",
        "description: 编写可靠的自动化测试",
        "---",
        "# 测试技能",
        "先写失败测试。",
      ].join("\n"),
    );

    const registry = await scanSkills(root);
    const catalog = formatSkillCatalog(registry);

    expect(catalog).toContain("testing: 编写可靠的自动化测试");
    expect(catalog).not.toContain("先写失败测试");
    expect(loadSkill(registry, "testing")).toContain("先写失败测试");
  });

  test("只按注册名称加载，不把输入解释为路径", async () => {
    const root = await mkdtemp(join(tmpdir(), "mini-agent-skills-"));
    directories.push(root);
    const registry = await scanSkills(root);

    expect(() => loadSkill(registry, "../secret")).toThrow(
      "未找到技能: ../secret",
    );
  });
});
