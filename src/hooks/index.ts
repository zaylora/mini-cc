import { HookBus } from "@/hooks/bus.js";
import {
  createAuditHook,
  createWorkingDirectoryHook,
} from "@/hooks/builtins.js";
import { createPermissionHook } from "@/hooks/permission.js";

export function createDefaultHookBus(): HookBus {
  const hooks = new HookBus();
  hooks.register("PreToolUse", createPermissionHook(), { priority: 100 });
  hooks.register("PreToolUse", createAuditHook());
  hooks.register("UserPromptSubmit", createWorkingDirectoryHook());
  return hooks;
}

export { HookBus } from "@/hooks/bus.js";
export type {
  HookEvent,
  HookFn,
  HookOutcome,
  HookPayload,
} from "@/hooks/bus.js";
export { createPermissionHook } from "@/hooks/permission.js";
export {
  createAuditHook,
  createWorkingDirectoryHook,
} from "@/hooks/builtins.js";
