import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { glob } from "glob";

export function safePath(path: string): string {
  const workdir = resolve(process.cwd());
  const resolved = resolve(workdir, path);
  const relativePath = relative(workdir, resolved);

  const parentPrefix = `..${process.platform === "win32" ? "\\" : "/"}`;
  if (
    relativePath === ".." ||
    relativePath.startsWith(parentPrefix) ||
    isAbsolute(relativePath)
  ) {
    throw new Error(`路径必须位于工作目录内: ${path}`);
  }

  return resolved;
}

export async function runRead(input: unknown): Promise<string> {
  const { path } = parsePathInput("read_file", input);
  return readFile(safePath(path), "utf8");
}

export async function runWrite(input: unknown): Promise<string> {
  if (!hasStringFields(input, "path", "content")) {
    throw new Error("write_file 工具需要字符串 path 和 content");
  }

  await writeFile(safePath(input.path), input.content, "utf8");
  return `已写入 ${input.path}`;
}

export async function runEdit(input: unknown): Promise<string> {
  if (!hasStringFields(input, "path", "old_text", "new_text")) {
    throw new Error("edit_file 工具需要字符串 path、old_text 和 new_text");
  }

  const path = safePath(input.path);
  const content = await readFile(path, "utf8");
  const index = content.indexOf(input.old_text);
  if (index === -1) {
    throw new Error(`未在 ${input.path} 中找到 old_text，请提供准确且唯一的原文后重试`);
  }

  const updated =
    content.slice(0, index) + input.new_text + content.slice(index + input.old_text.length);
  await writeFile(path, updated, "utf8");
  return `已修改 ${input.path}`;
}

export async function runGlob(input: unknown): Promise<string> {
  const { path: pattern } = parsePathInput("glob", input, "pattern");
  const absolutePattern = safePath(pattern);
  const matches = await glob(absolutePattern, {
    nodir: true,
    windowsPathsNoEscape: true,
  });
  return matches.map((match) => relative(process.cwd(), match)).join("\n");
}

function parsePathInput(
  tool: string,
  input: unknown,
  field = "path",
): { path: string } {
  if (!hasStringFields(input, field)) {
    throw new Error(`${tool} 工具需要字符串 ${field}`);
  }
  return { path: input[field] };
}

function hasStringFields<K extends string>(
  input: unknown,
  ...fields: K[]
): input is Record<K, string> {
  return (
    typeof input === "object" &&
    input !== null &&
    fields.every((field) => typeof (input as Record<string, unknown>)[field] === "string")
  );
}
