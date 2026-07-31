import Anthropic from "@anthropic-ai/sdk";
import type {
  Message,
  MessageParam,
  Tool,
} from "@anthropic-ai/sdk/resources/messages/messages";
import { getAnthropicClientOptions, getModelId } from "@/config.js";

let client: Anthropic | undefined;
let clientOptionsKey: string | undefined;

export async function callModel(
  system: string,
  messages: MessageParam[],
  tools: Tool[],
  maxTokens: number,
): Promise<Message> {
  const clientOptions = getAnthropicClientOptions();
  const optionsKey = JSON.stringify(clientOptions);
  if (!client || clientOptionsKey !== optionsKey) {
    client = new Anthropic(clientOptions);
    clientOptionsKey = optionsKey;
  }

  return client.messages.create({
    model: getModelId(),
    max_tokens: maxTokens,
    system,
    messages,
    tools,
  });
}
