import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import type { State } from "@/core/state.js";
import { dispatch, TOOLS } from "@/tools/registry.js";
import { loadSkill, type SkillRegistry } from "@/tools/skill.js";
import { runTodoWrite } from "@/tools/todo.js";

export interface RuntimeToolContext {
  state: State;
  skills: SkillRegistry;
  spawnSubagent: (description: string) => Promise<string>;
}

export interface RuntimeTools {
  definitions: Tool[];
  dispatch: (name: string, input: unknown) => Promise<string>;
}

export function createRuntimeTools(context: RuntimeToolContext): RuntimeTools {
  const handlers: Record<string, (input: unknown) => Promise<string>> = {
    todo_write: (input) => runTodoWrite(context.state, input),
    load_skill: async (input) => loadSkill(context.skills, readString(input, "name")),
  };
  if (context.state.depth === 0) {
    handlers.task = (input) => context.spawnSubagent(readString(input, "description"));
  }

  return {
    definitions: context.state.depth === 0
      ? TOOLS
      : TOOLS.filter((tool) => tool.name !== "task"),
    dispatch: (name, input) => {
      const handler = handlers[name];
      return handler ? handler(input) : dispatch(name, input);
    },
  };
}

function readString(input: unknown, key: string): string {
  if (typeof input !== "object" || input === null) {
    throw new Error(`${key} 必须是字符串`);
  }
  const value = (input as Record<string, unknown>)[key];
  if (typeof value !== "string") throw new Error(`${key} 必须是字符串`);
  return value;
}
