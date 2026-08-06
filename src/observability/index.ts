import type { LangfuseConfig } from "@/config.js";
import { getLangfuseConfig } from "@/config.js";
import { noopTelemetry } from "@/observability/noop.js";
import type {
  ObservabilityLifecycle,
  Telemetry,
} from "@/observability/types.js";

export interface CreateObservabilityOptions {
  env?: Record<string, string | undefined>;
  warn?: (message: string) => void;
  createEnabledTelemetry?: (
    config: LangfuseConfig,
    warn: (message: string) => void,
  ) => Promise<Telemetry> | Telemetry;
}

export async function createObservability(
  options: CreateObservabilityOptions = {},
): Promise<ObservabilityLifecycle> {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  let config: LangfuseConfig | undefined;
  try {
    config = getLangfuseConfig(options.env ?? process.env);
  } catch (error) {
    warn(errorMessage(error));
    return lifecycle(noopTelemetry);
  }
  if (!config) return lifecycle(noopTelemetry);

  try {
    const factory = options.createEnabledTelemetry ??
      (async (nextConfig: LangfuseConfig, nextWarn: (message: string) => void) => {
        const { createLangfuseTelemetry } = await import(
          "@/observability/langfuse.js"
        );
        return createLangfuseTelemetry(nextConfig, nextWarn);
      });
    return lifecycle(await factory(config, warn));
  } catch (error) {
    warn(`Langfuse 初始化失败：${errorMessage(error)}`);
    return lifecycle(noopTelemetry);
  }
}

function lifecycle(telemetry: Telemetry): ObservabilityLifecycle {
  return {
    telemetry,
    shutdown: (timeoutMs) => telemetry.shutdown(timeoutMs),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export { noopTelemetry } from "@/observability/noop.js";
export type {
  ObservabilityLifecycle,
  ObservationAttributes,
  ObservationType,
  Telemetry,
  TelemetryObservation,
} from "@/observability/types.js";
