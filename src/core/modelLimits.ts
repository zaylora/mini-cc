const LOW_CEILING_MODEL_PREFIXES = [
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
  "claude-opus-4-5",
  "claude-opus-4-1",
  "claude-opus-4-0",
  "claude-sonnet-4-0",
  "claude-3-",
  "claude-2.",
];
const LOW_CEILING_MAX_TOKENS = 64_000;
const DEFAULT_MAX_TOKENS = 128_000;
export const CONTEXT_WINDOW_TOKENS = 200_000;

export function maxOutputTokensFor(modelId: string): number {
  const isLowCeiling = LOW_CEILING_MODEL_PREFIXES.some((prefix) =>
    modelId.startsWith(prefix),
  );
  return isLowCeiling ? LOW_CEILING_MAX_TOKENS : DEFAULT_MAX_TOKENS;
}
