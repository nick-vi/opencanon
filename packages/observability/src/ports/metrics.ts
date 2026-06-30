import type { MetricKind, MetricMeasurement } from '../primitives/metrics.ts';

export type MetricQuery = {
  name?: string | undefined;
  kind?: MetricKind | undefined;
};

export interface MetricsRecorder {
  record(measurement: MetricMeasurement): Promise<void>;
  list(query?: MetricQuery): Promise<MetricMeasurement[]>;
  clear(): Promise<void>;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}
