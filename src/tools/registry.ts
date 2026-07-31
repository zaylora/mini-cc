import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages";
import { runBash } from "@/tools/bash.js";
import { runEdit, runGlob, runRead, runWrite } from "@/tools/fs.js";

type Handler = (input: unknown) => Promise<string>;

const BASE_TOOLS: Tool[] = [
  {
    name: "bash",
    description:
      "Execute a shell command in the current working directory and return stdout, stderr, and the exit code.",
    input_schema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The shell command to execute.",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
  },
  {
    name: "read_file",
    description: "Read a UTF-8 text file inside the current working directory.",
    input_schema: {
      type: "object",
      properties: { path: { type: "string", description: "File path to read." } },
      required: ["path"],
      additionalProperties: false,
    },
  },
  {
    name: "write_file",
    description: "Write UTF-8 content to a file inside the current working directory.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to write." },
        content: { type: "string", description: "Complete file content." },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
  },
  {
    name: "edit_file",
    description: "Replace the first exact occurrence of text in a UTF-8 file.",
    input_schema: {
      type: "object",
      properties: {
        path: { type: "string", description: "File path to edit." },
        old_text: { type: "string", description: "Exact text to replace." },
        new_text: { type: "string", description: "Replacement text." },
      },
      required: ["path", "old_text", "new_text"],
      additionalProperties: false,
    },
  },
  {
    name: "glob",
    description: "List files inside the current working directory matching a glob pattern.",
    input_schema: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Glob pattern such as src/**/*.ts." },
      },
      required: ["pattern"],
      additionalProperties: false,
    },
  },
];

const TODO_TOOL: Tool = {
  name: "todo_write",
  description: "Create or update the current task plan and its progress.",
  input_schema: {
    type: "object",
    properties: {
      todos: {
        type: "array",
        items: {
          type: "object",
          properties: {
            content: { type: "string" },
            status: {
              type: "string",
              enum: ["pending", "in_progress", "completed"],
            },
          },
          required: ["content", "status"],
          additionalProperties: false,
        },
      },
    },
    required: ["todos"],
    additionalProperties: false,
  },
};

const TASK_TOOL: Tool = {
  name: "task",
  description: "Launch an isolated subagent for one complex subtask and return only its conclusion.",
  input_schema: {
    type: "object",
    properties: {
      description: { type: "string", description: "A complete, self-contained subtask." },
    },
    required: ["description"],
    additionalProperties: false,
  },
};

const SKILL_TOOL: Tool = {
  name: "load_skill",
  description: "Load the full instructions for one skill listed in the system prompt.",
  input_schema: {
    type: "object",
    properties: { name: { type: "string", description: "Registered skill name." } },
    required: ["name"],
    additionalProperties: false,
  },
};

export const TOOLS: Tool[] = [...BASE_TOOLS, TODO_TOOL, TASK_TOOL, SKILL_TOOL];

const BASE_HANDLERS: Record<string, Handler> = {
  bash: runBash,
  read_file: runRead,
  write_file: runWrite,
  edit_file: runEdit,
  glob: runGlob,
};

export async function dispatch(name: string, input: unknown): Promise<string> {
  return dispatchWithHandlers(BASE_HANDLERS, name, input);
}

async function dispatchWithHandlers(
  handlers: Record<string, Handler>,
  name: string,
  input: unknown,
): Promise<string> {
  const handler = handlers[name];
  if (!handler) throw new Error(`未知工具: ${name}`);
  return handler(input);
}
