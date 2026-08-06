import type {
  ObservationAttributes,
  ObservationType,
  Telemetry,
  TelemetryObservation,
} from "@/observability/types.js";

const noopObservation: TelemetryObservation = {
  update(): void {},
};

export const noopTelemetry: Telemetry = {
  enabled: false,
  async observe<T>(
    _name: string,
    _options: ObservationAttributes & { asType: ObservationType },
    run: (observation: TelemetryObservation) => Promise<T>,
  ): Promise<T> {
    return run(noopObservation);
  },
  event(): void {},
  async flush(): Promise<void> {},
  async shutdown(): Promise<void> {},
};
