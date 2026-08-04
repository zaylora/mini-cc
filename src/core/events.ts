import type { Todo } from "@/core/state.js";

export interface AgentEventMap {
  "step-start": { step: number; depth: number };
  "assistant-message": { text: string; depth: number };
  "assistant-delta": { text: string; depth: number };
  "assistant-flush": { depth: number };
  "stream-interrupted": { reason: string; depth: number };
  "tool-start": {
    id: string;
    toolName: string;
    input: unknown;
    depth: number;
  };
  "tool-end": {
    id: string;
    toolName: string;
    result: string;
    isError: boolean;
    depth: number;
  };
  "todo-changed": { todos: Todo[]; depth: number };
}

export type AgentEventName = keyof AgentEventMap;

type Listener<E extends AgentEventName> = (
  payload: AgentEventMap[E],
) => void;

export interface AgentEvents {
  on<E extends AgentEventName>(event: E, listener: Listener<E>): void;
  emit<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): void;
}

export function createAgentEvents(): AgentEvents {
  const listeners = new Map<
    AgentEventName,
    Array<Listener<AgentEventName>>
  >();

  return {
    on<E extends AgentEventName>(event: E, listener: Listener<E>): void {
      const eventListeners = listeners.get(event) ?? [];
      eventListeners.push(listener as Listener<AgentEventName>);
      listeners.set(event, eventListeners);
    },
    emit<E extends AgentEventName>(event: E, payload: AgentEventMap[E]): void {
      for (const listener of listeners.get(event) ?? []) {
        listener(payload);
      }
    },
  };
}
