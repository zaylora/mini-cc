export interface HookPayload {
  UserPromptSubmit: { prompt: string };
  PreToolUse: { toolName: string; input: unknown };
  PostToolUse: { toolName: string; input: unknown; result: string };
  Stop: { turnCount: number };
}

export type HookEvent = keyof HookPayload;

export type HookOutcome =
  | { action: "continue" } // 继续执行，不改变当前流程
  | { action: "block"; reason: string } // 阻止工具调用，并回灌原因
  | { action: "ask"; message: string } // 请求 CLI 向用户确认
  | { action: "inject"; context: string } // 向模型追加上下文
  | { action: "respawn"; message: string }; // Stop 阶段要求继续运行

export type HookFn<E extends HookEvent = HookEvent> = (
  payload: HookPayload[E],
) => Promise<HookOutcome> | HookOutcome;

type RegisteredHook = { fn: HookFn; priority: number };

export class HookBus {
  private readonly hooks: Record<HookEvent, RegisteredHook[]> = {
    UserPromptSubmit: [],
    PreToolUse: [],
    PostToolUse: [],
    Stop: [],
  };

  register<E extends HookEvent>(
    event: E,
    fn: HookFn<E>,
    options: { priority?: number } = {},
  ): void {
    this.hooks[event].push({ fn: fn as HookFn, priority: options.priority ?? 0 });
    this.hooks[event].sort((left, right) => right.priority - left.priority);
  }

  async trigger<E extends HookEvent>(
    event: E,
    payload: HookPayload[E],
  ): Promise<HookOutcome> {
    const injections: string[] = [];
    for (const hook of this.hooks[event]) {
      const outcome = await hook.fn(payload);
      if (outcome.action === "inject") injections.push(outcome.context);
      if (
        (event === "PreToolUse" || event === "Stop") &&
        outcome.action !== "continue"
      ) {
        return outcome;
      }
    }

    return injections.length > 0
      ? { action: "inject", context: injections.join("\n") }
      : { action: "continue" };
  }
}
