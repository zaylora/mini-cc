export interface ModelTurn {
  deltas: string[];
  stopReason: "end_turn" | "tool_use";
  toolUse?: { id: string; name: string; input: unknown };
  inputTokens?: number;
  waitFor?: Promise<void>;
}

export function createStreamingModelServer(
  turns: ModelTurn[],
): ReturnType<typeof Bun.serve> {
  let index = 0;
  return Bun.serve({
    port: 0,
    async fetch(request) {
      await request.json();
      const turn = turns[index] ?? turns.at(-1)!;
      index += 1;
      await turn.waitFor;
      const events: string[] = [
        `event: message_start\ndata: ${JSON.stringify({
          type: "message_start",
          message: {
            id: `msg-${index}`,
            type: "message",
            role: "assistant",
            model: "test-model",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: turn.inputTokens ?? 1, output_tokens: 0 },
          },
        })}\n\n`,
      ];

      if (turn.stopReason === "tool_use" && turn.toolUse) {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "tool_use",
              id: turn.toolUse.id,
              name: turn.toolUse.name,
              input: {},
            },
          })}\n\n`,
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: "content_block_delta",
            index: 0,
            delta: {
              type: "input_json_delta",
              partial_json: JSON.stringify(turn.toolUse.input),
            },
          })}\n\n`,
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        );
      } else {
        events.push(
          `event: content_block_start\ndata: ${JSON.stringify({
            type: "content_block_start",
            index: 0,
            content_block: { type: "text", text: "" },
          })}\n\n`,
        );
        for (const delta of turn.deltas) {
          events.push(
            `event: content_block_delta\ndata: ${JSON.stringify({
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: delta },
            })}\n\n`,
          );
        }
        events.push(
          `event: content_block_stop\ndata: ${JSON.stringify({
            type: "content_block_stop",
            index: 0,
          })}\n\n`,
        );
      }

      events.push(
        `event: message_delta\ndata: ${JSON.stringify({
          type: "message_delta",
          delta: { stop_reason: turn.stopReason, stop_sequence: null },
          usage: { output_tokens: 1 },
        })}\n\n`,
        `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      );

      return new Response(events.join(""), {
        headers: { "content-type": "text/event-stream" },
      });
    },
  });
}

export function useTestModel(baseUrl: string): () => void {
  const previous = [process.env.API_KEY, process.env.BASE_URL, process.env.MODEL_ID];
  process.env.API_KEY = "test-key";
  process.env.BASE_URL = baseUrl;
  process.env.MODEL_ID = "test-model";
  return () => {
    restoreEnvironment("API_KEY", previous[0]);
    restoreEnvironment("BASE_URL", previous[1]);
    restoreEnvironment("MODEL_ID", previous[2]);
  };
}

export function flush(delay = 350): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delay));
}

export async function waitFor(
  condition: () => boolean,
  timeout = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (condition()) return;
    await flush(25);
  }
  throw new Error(`等待条件满足超时（${timeout}ms）`);
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
