import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";

const PERSISTED_TAG = "<persisted-output";

export async function persistToolResult(
  root: string,
  toolUseId: string,
  content: string,
  previewLength: number,
): Promise<string> {
  const directory = join(root, ".minicc", "task_outputs", "tool-results");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${uniqueName()}-${safeName(toolUseId)}.txt`);
  await writeFile(path, content, "utf8");
  const relativePath = path.slice(root.length + 1).replaceAll("\\", "/");
  const preview = content.slice(0, previewLength);
  return `${PERSISTED_TAG} path="${relativePath}">\n${preview}\n</persisted-output>`;
}

/** 从工具结果正文中取回落盘路径；不是落盘引用时返回 undefined。 */
export function persistedOutputPath(content: string): string | undefined {
  if (!content.startsWith(PERSISTED_TAG)) return undefined;
  return /^<persisted-output path="([^"]+)"/.exec(content)?.[1];
}

/** 丢掉预览、只保留恢复路径的最小引用。 */
export function persistedOutputReference(path: string): string {
  return `${PERSISTED_TAG} path="${path}" />`;
}

export async function writeTranscript(
  root: string,
  messages: MessageParam[],
): Promise<string> {
  const directory = join(root, ".minicc", "transcripts");
  await mkdir(directory, { recursive: true });
  const path = join(directory, `${uniqueName()}.jsonl`);
  const content = messages.map((message) => JSON.stringify(message)).join("\n");
  await writeFile(path, `${content}\n`, "utf8");
  return path;
}

function uniqueName(): string {
  return `${Date.now()}-${crypto.randomUUID()}`;
}

function safeName(value: string): string {
  return value.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
}
