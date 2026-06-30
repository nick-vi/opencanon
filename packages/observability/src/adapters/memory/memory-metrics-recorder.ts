import type { MetricQuery, MetricsRecorder } from '@opencanon/observability/ports';
import { assertObservabilityOpen, metric, type MetricMeasurement } from '@opencanon/observability/primitives';
import { filterMetricMeasurements } from '../metrics-recorder-utils.ts';

export class InMemoryMetricsRecorder implements MetricsRecorder {
  private readonly measurements: MetricMeasurement[] = [];
  private closed = false;

  async record(measurement: MetricMeasurement): Promise<void> {
    assertObservabilityOpen(this.closed, 'InMemoryMetricsRecorder');
    this.measurements.push(structuredClone(metric(measurement)));
  }

  async list(query: MetricQuery = {}): Promise<MetricMeasurement[]> {
    assertObservabilityOpen(this.closed, 'InMemoryMetricsRecorder');
    return filterMetricMeasurements(this.measurements, query).map((measurement) =>
      structuredClone(measurement)
    );
  }

  async clear(): Promise<void> {
    assertObservabilityOpen(this.closed, 'InMemoryMetricsRecorder');
    this.measurements.length = 0;
  }

  async forceFlush(): Promise<void> {
    assertObservabilityOpen(this.closed, 'InMemoryMetricsRecorder');
  }

  async shutdown(): Promise<void> {
    this.closed = true;
  }
}
