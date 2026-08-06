import { AsyncLocalStorage } from "node:async_hooks";
import type {
  ObservationAttributes,
  ObservationType,
  Telemetry,
  TelemetryObservation,
} from "@/observability/types.js";

export interface TelemetryRecord {
  id: string;
  parentId?: string;
  name: string;
  type: ObservationType;
  attributes: ObservationAttributes;
  children: TelemetryRecord[];
}

export interface RecordingTelemetry extends Telemetry {
  records: TelemetryRecord[];
  flushCount: number;
  shutdownCount: number;
  tree(): TelemetryRecord[];
}

export function createRecordingTelemetry(): RecordingTelemetry {
  const storage = new AsyncLocalStorage<string>();
  const records: TelemetryRecord[] = [];
  let nextId = 0;

  const telemetry: RecordingTelemetry = {
    enabled: true,
    records,
    flushCount: 0,
    shutdownCount: 0,
    async observe<T>(
      name: string,
      options: ObservationAttributes & { asType: ObservationType },
      run: (observation: TelemetryObservation) => Promise<T>,
    ): Promise<T> {
      nextId += 1;
      const record: TelemetryRecord = {
        id: `observation-${nextId}`,
        parentId: storage.getStore(),
        name,
        type: options.asType,
        attributes: { ...options },
        children: [],
      };
      records.push(record);
      const observation: TelemetryObservation = {
        traceId: record.parentId ? "trace-1" : `trace-${nextId}`,
        update(attributes): void {
          record.attributes = mergeAttributes(record.attributes, attributes);
        },
      };
      return storage.run(record.id, () => run(observation));
    },
    event(name, attributes = {}): void {
      nextId += 1;
      records.push({
        id: `observation-${nextId}`,
        parentId: storage.getStore(),
        name,
        type: "event",
        attributes,
        children: [],
      });
    },
    async flush(): Promise<void> {
      telemetry.flushCount += 1;
    },
    async shutdown(): Promise<void> {
      telemetry.shutdownCount += 1;
    },
    tree(): TelemetryRecord[] {
      const byId = new Map(records.map((record) => [record.id, record]));
      const roots: TelemetryRecord[] = [];
      for (const record of records) {
        record.children = [];
      }
      for (const record of records) {
        const parent = record.parentId ? byId.get(record.parentId) : undefined;
        if (parent) parent.children.push(record);
        else roots.push(record);
      }
      return roots;
    },
  };

  return telemetry;
}

function mergeAttributes(
  current: ObservationAttributes,
  next: ObservationAttributes,
): ObservationAttributes {
  return {
    ...current,
    ...next,
    metadata: current.metadata || next.metadata
      ? { ...current.metadata, ...next.metadata }
      : undefined,
    usageDetails: current.usageDetails || next.usageDetails
      ? { ...current.usageDetails, ...next.usageDetails }
      : undefined,
  };
}
