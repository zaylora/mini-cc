import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";

export interface State {
  messages: MessageParam[];
  steps: number;
  stopRespawnCount: number;
}

export function createState(): State {
  return { messages: [], steps: 0, stopRespawnCount: 0 };
}
