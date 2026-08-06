export type ObservationType =
  | "span"
  | "agent"
  | "generation"
  | "tool"
  | "evaluator"
  | "event";

export interface ObservationAttributes {
  input?: unknown;
  output?: unknown;
  metadata?: Record<string, unknown>;
  level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
  statusMessage?: string;
  model?: string;
  modelParameters?: Record<string, string | number>;
  usageDetails?: Record<string, number>;
  completionStartTime?: Date;
}

export interface TelemetryObservation {
  readonly traceId?: string;
  update(attributes: ObservationAttributes): void;
}

export interface Telemetry {
  readonly enabled: boolean;
  observe<T>(
    name: string,
    options: ObservationAttributes & { asType: ObservationType },
    run: (observation: TelemetryObservation) => Promise<T>,
  ): Promise<T>;
  event(name: string, attributes?: ObservationAttributes): void;
  flush(timeoutMs?: number): Promise<void>;
  shutdown(timeoutMs?: number): Promise<void>;
}

export interface ObservabilityLifecycle {
  telemetry: Telemetry;
  shutdown(timeoutMs?: number): Promise<void>;
}
