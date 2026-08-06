import "dotenv/config";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export const MAX_STEPS = 90;

export interface LangfuseConfig {
  publicKey: string;
  secretKey: string;
  baseUrl: string;
}

export function getModelId(): string {
  return (
    process.env.ANTHROPIC_MODEL ?? process.env.MODEL_ID ?? "claude-sonnet-5"
  );
}

export function getAnthropicClientOptions(): {
  apiKey?: string;
  baseURL?: string;
} {
  return {
    apiKey: process.env.API_KEY,
    baseURL: process.env.BASE_URL,
  };
}

export function getEvalWorkspaceRoot(
  env: Record<string, string | undefined> = process.env,
): string {
  const configuredRoot = env.EVAL_WORKSPACE_ROOT?.trim();
  return resolve(configuredRoot || tmpdir());
}

export function getLangfuseConfig(
  env: Record<string, string | undefined> = process.env,
): LangfuseConfig | undefined {
  const publicKey = env.LANGFUSE_PUBLIC_KEY;
  const secretKey = env.LANGFUSE_SECRET_KEY;
  if (!publicKey && !secretKey) return undefined;
  if (!publicKey || !secretKey) {
    throw new Error(
      "Langfuse 需要同时配置 LANGFUSE_PUBLIC_KEY 和 LANGFUSE_SECRET_KEY",
    );
  }
  return {
    publicKey,
    secretKey,
    baseUrl: env.LANGFUSE_BASE_URL ?? "https://cloud.langfuse.com",
  };
}
