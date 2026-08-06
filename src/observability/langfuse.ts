import { LangfuseSpanProcessor } from "@langfuse/otel";
import {
  startActiveObservation,
  startObservation,
} from "@langfuse/tracing";
import { NodeSDK } from "@opentelemetry/sdk-node";
import type { LangfuseConfig } from "@/config.js";
import type {
  ObservationAttributes,
  ObservationType,
  Telemetry,
  TelemetryObservation,
} from "@/observability/types.js";

type Warn = (message: string) => void;

interface UpdatableObservation {
  traceId: string;
  update(attributes: ObservationAttributes): unknown;
}

type StartActive = <T>(
  name: string,
  run: (observation: UpdatableObservation) => Promise<T>,
  options: { asType: ObservationType },
) => Promise<T>;

interface FlushProcessor {
  forceFlush(): Promise<void>;
}

interface TelemetrySdk {
  start(): void;
  shutdown(): Promise<void>;
}

interface EndableObservation {
  end(): void;
}

export interface LangfuseTelemetryRuntime {
  createProcessor(config: LangfuseConfig): FlushProcessor;
  createSdk(processor: FlushProcessor): TelemetrySdk;
  startActive: StartActive;
  startEvent(
    name: string,
    attributes: ObservationAttributes,
  ): EndableObservation;
}

export function createLangfuseTelemetry(
  config: LangfuseConfig,
  warn: Warn = console.warn,
): Telemetry {
  return createLangfuseTelemetryRuntime(config, warn, {
    createProcessor: (nextConfig) => new LangfuseSpanProcessor(nextConfig),
    createSdk: (processor) => new NodeSDK({
      spanProcessors: [processor as LangfuseSpanProcessor],
    }),
    startActive: startActiveObservation as unknown as StartActive,
    startEvent: (name, attributes) =>
      startObservation(name, attributes, { asType: "event" }),
  });
}

export function createLangfuseTelemetryRuntime(
  config: LangfuseConfig,
  warn: Warn,
  runtime: LangfuseTelemetryRuntime,
): Telemetry {
  const processor = runtime.createProcessor(config);
  const sdk = runtime.createSdk(processor);
  sdk.start();
  let stopped = false;

  return {
    enabled: true,
    observe<T>(
      name: string,
      options: ObservationAttributes & { asType: ObservationType },
      run: (observation: TelemetryObservation) => Promise<T>,
    ): Promise<T> {
      const { asType, ...attributes } = options;
      return runtime.startActive(
        name,
        async (observation) => {
          let currentAttributes = mergeObservationAttributes({}, attributes);
          observation.update(currentAttributes);
          const wrapped: TelemetryObservation = {
            traceId: observation.traceId,
            update(next): void {
              currentAttributes = mergeObservationAttributes(
                currentAttributes,
                next,
              );
              observation.update(currentAttributes);
            },
          };
          try {
            return await run(wrapped);
          } catch (error) {
            wrapped.update({
              level: "ERROR",
              statusMessage: errorMessage(error),
            });
            throw error;
          }
        },
        { asType },
      );
    },
    event(name, attributes = {}): void {
      runtime.startEvent(name, attributes).end();
    },
    async flush(timeoutMs = 2_000): Promise<void> {
      if (stopped) return;
      await settleWithin(processor.forceFlush(), timeoutMs, "刷新", warn);
    },
    async shutdown(timeoutMs = 2_000): Promise<void> {
      if (stopped) return;
      stopped = true;
      await settleWithin(sdk.shutdown(), timeoutMs, "关闭", warn);
    },
  };
}

function mergeObservationAttributes(
  current: ObservationAttributes,
  next: ObservationAttributes,
): ObservationAttributes {
  const definedNext = Object.fromEntries(
    Object.entries(next).filter(([, value]) => value !== undefined),
  ) as ObservationAttributes;
  return {
    ...current,
    ...definedNext,
    metadata: current.metadata || definedNext.metadata
      ? { ...current.metadata, ...definedNext.metadata }
      : undefined,
    modelParameters: current.modelParameters || definedNext.modelParameters
      ? { ...current.modelParameters, ...definedNext.modelParameters }
      : undefined,
    usageDetails: current.usageDetails || definedNext.usageDetails
      ? { ...current.usageDetails, ...definedNext.usageDetails }
      : undefined,
  };
}

async function settleWithin(
  operation: Promise<unknown>,
  timeoutMs: number,
  action: string,
  warn: Warn,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`Langfuse ${action}超时（${timeoutMs}ms）`)),
          timeoutMs,
        );
      }),
    ]);
  } catch (error) {
    warn(errorMessage(error));
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
