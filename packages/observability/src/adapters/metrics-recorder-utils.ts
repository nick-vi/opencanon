import type { MetricQuery } from '../ports/metrics.ts';
import type { MetricMeasurement } from '../primitives/metrics.ts';

export function filterMetricMeasurements(
  measurements: readonly MetricMeasurement[],
  query: MetricQuery = {}
): MetricMeasurement[] {
  return measurements
    .filter((measurement) => query.name == null || measurement.name === query.name)
    .filter((measurement) => query.kind == null || measurement.kind === query.kind)
    .sort(compareMetricMeasurements);
}

export function compareMetricMeasurements(
  left: MetricMeasurement,
  right: MetricMeasurement
): number {
  return left.observedAt.localeCompare(right.observedAt) || left.name.localeCompare(right.name);
}
