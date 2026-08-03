import "dotenv/config";

export const MAX_TOKENS = 16_000;
export const MAX_STEPS = 90;

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
