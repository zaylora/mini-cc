import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { getEvalWorkspaceRoot } from "@/config.js";
import type { EvalWorkspace } from "@/evaluation/types.js";

export async function createEvalWorkspace(
  files: Record<string, string>,
  parentRoot = getEvalWorkspaceRoot(),
): Promise<EvalWorkspace> {
  await mkdir(parentRoot, { recursive: true });
  const root = await mkdtemp(join(parentRoot, "mini-cc-eval-"));
  try {
    for (const [path, content] of Object.entries(files)) {
      const target = resolveWorkspacePath(root, path);
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content, "utf8");
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }

  return {
    path: root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

export function resolveWorkspacePath(root: string, path: string): string {
  const resolvedRoot = resolve(root);
  const target = resolve(resolvedRoot, path);
  const relativePath = relative(resolvedRoot, target);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`路径不能离开评测工作区：${path}`);
  }
  return target;
}
