import type { MessageParam } from "@anthropic-ai/sdk/resources/messages/messages";

export function renderLastAssistantMessage(messages: MessageParam[]): string {
  let message: MessageParam | undefined;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index]?.role === "assistant") {
      message = messages[index];
      break;
    }
  }
  if (!message) return "";
  if (typeof message.content === "string") return message.content;

  return message.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");
}
