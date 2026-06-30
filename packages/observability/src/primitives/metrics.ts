import type { JsonObject, JsonPrimitive, JsonValue } from './json-value.ts';
import { positiveIntegerOption } from './runtime-options.ts';
import {
  isTelemetryAttributeValue,
  type TelemetryAttributes,
  type TelemetryResource,
} from './telemetry-resource.ts';

export type MetricJsonPrimitive = JsonPrimitive;
export type MetricJsonValue = JsonValue;
export type MetricJsonObject = JsonObject;

export const METRIC_OVERFLOW_ATTRIBUTE = 'otel.metric.overflow';

export const DEFAULT_METRIC_ATTRIBUTE_LIMITS = Object.freeze({
  maxAttributes: 64,
  maxAttributeKeyLength: 128,
  maxAttributeValueLength: 512,
  overflowAttribute: METRIC_OVERFLOW_ATTRIBUTE,
} as const);

export const MetricKind = Object.freeze({
  Counter: 'counter',
  Gauge: 'gauge',
  Duration: 'duration',
} as const);

export type MetricKind = (typeof MetricKind)[keyof typeof MetricKind];

export type MetricMeasurement = {
  name: string;
  kind: MetricKind;
  value: number;
  observedAt: string;
  unit?: string | undefined;
  attributes?: TelemetryAttributes | undefined;
  resource?: TelemetryResource | undefined;
  exemplar?: MetricExemplar | undefined;
  droppedAttributes?: number | undefined;
};

export type MetricExemplar = {
  value: number;
  observedAt: string;
  traceId: string;
  spanId: string;
  traceFlags?: string | undefined;
  sampled: boolean;
  attributes?: TelemetryAttributes | undefined;
};

export type MetricObservationContext = {
  traceId?: string | undefined;
  spanId?: string | undefined;
  traceFlags?: string | undefined;
  sampled?: boolean | undefined;
};

export type MetricAttributeLimits = {
  maxAttributes?: number | undefined;
  maxAttributeKeyLength?: number | undefined;
  maxAttributeValueLength?: number | undefined;
  overflowAttribute?: string | undefined;
};

export type NormalizedMetricAttributes = {
  attributes: TelemetryAttributes;
  droppedAttributes: number;
  overflow: boolean;
};

export function metric(
  input: MetricMeasurement,
  limits: MetricAttributeLimits = {}
): MetricMeasurement {
  if (input.name.trim().length === 0) {
    throw new MetricError('Metric name must not be empty');
  }
  if (!Number.isFinite(input.value)) {
    throw new MetricError('Metric value must be finite');
  }
  if (input.exemplar != null && !Number.isFinite(input.exemplar.value)) {
    throw new MetricError('Metric exemplar value must be finite');
  }

  const normalized = normalizeMetricAttributes(input.attributes ?? {}, limits);

  return {
    name: input.name,
    kind: input.kind,
    value: input.value,
    observedAt: input.observedAt,
    ...(input.unit != null ? { unit: input.unit } : {}),
    ...(Object.keys(normalized.attributes).length > 0
      ? { attributes: normalized.attributes }
      : {}),
    ...(input.resource != null ? { resource: structuredClone(input.resource) } : {}),
    ...(input.exemplar != null ? { exemplar: normalizeMetricExemplar(input.exemplar, limits) } : {}),
    ...(normalized.droppedAttributes > 0
      ? { droppedAttributes: normalized.droppedAttributes }
      : input.droppedAttributes != null
        ? { droppedAttributes: input.droppedAttributes }
        : {}),
  };
}

export class MetricError extends Error {
  override readonly name = 'MetricError';
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    message: string,
    details?: Record<string, unknown> | undefined
  ) {
    super(message);
    this.details = details;
  }
}

export function normalizeMetricAttributes(
  attributes: TelemetryAttributes,
  limits: MetricAttributeLimits = {}
): NormalizedMetricAttributes {
  const maxAttributes = positiveIntegerOption(
    'maxAttributes',
    limits.maxAttributes ?? DEFAULT_METRIC_ATTRIBUTE_LIMITS.maxAttributes
  );
  const maxAttributeKeyLength = positiveIntegerOption(
    'maxAttributeKeyLength',
    limits.maxAttributeKeyLength ?? DEFAULT_METRIC_ATTRIBUTE_LIMITS.maxAttributeKeyLength
  );
  const maxAttributeValueLength = positiveIntegerOption(
    'maxAttributeValueLength',
    limits.maxAttributeValueLength ?? DEFAULT_METRIC_ATTRIBUTE_LIMITS.maxAttributeValueLength
  );
  const overflowAttribute =
    limits.overflowAttribute ?? DEFAULT_METRIC_ATTRIBUTE_LIMITS.overflowAttribute;

  if (overflowAttribute.trim().length === 0) {
    throw new MetricError('Metric overflow attribute must not be empty');
  }

  const entries = Object.entries(attributes)
    .filter(([_key, value]) => value !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  const output: TelemetryAttributes = {};
  const hasOverflow = entries.length > maxAttributes;
  const maxRegularAttributes = hasOverflow ? Math.max(0, maxAttributes - 1) : maxAttributes;
  let droppedAttributes = 0;

  for (const [key, value] of entries) {
    if (key.trim().length === 0) {
      throw new MetricError('Metric attribute key must not be empty');
    }
    if (key.length > maxAttributeKeyLength) {
      throw new MetricError('Metric attribute key is too long', {
        key,
        max: maxAttributeKeyLength,
      });
    }
    if (!isTelemetryAttributeValue(value)) {
      throw new MetricError('Metric attribute value must be a finite scalar', { key });
    }
    if (typeof value === 'string' && value.length > maxAttributeValueLength) {
      throw new MetricError('Metric attribute value is too long', {
        key,
        max: maxAttributeValueLength,
      });
    }

    if (Object.keys(output).length >= maxRegularAttributes) {
      droppedAttributes += 1;
      continue;
    }

    output[key] = value;
  }

  if (hasOverflow) {
    output[overflowAttribute] = true;
  }

  return {
    attributes: output,
    droppedAttributes,
    overflow: hasOverflow,
  };
}

export function metricExemplarFromContext(
  context: MetricObservationContext | undefined,
  input: {
    value: number;
    observedAt: string;
    attributes?: TelemetryAttributes | undefined;
  }
): MetricExemplar | undefined {
  if (context?.sampled !== true || context.traceId == null || context.spanId == null) {
    return undefined;
  }

  return normalizeMetricExemplar(
    {
      value: input.value,
      observedAt: input.observedAt,
      traceId: context.traceId,
      spanId: context.spanId,
      ...(context.traceFlags != null ? { traceFlags: context.traceFlags } : {}),
      sampled: true,
      ...(input.attributes != null ? { attributes: input.attributes } : {}),
    },
    {}
  );
}

function normalizeMetricExemplar(
  exemplar: MetricExemplar,
  limits: MetricAttributeLimits
): MetricExemplar {
  if (!Number.isFinite(exemplar.value)) {
    throw new MetricError('Metric exemplar value must be finite');
  }

  const attributes = normalizeMetricAttributes(exemplar.attributes ?? {}, limits);
  return {
    value: exemplar.value,
    observedAt: exemplar.observedAt,
    traceId: exemplar.traceId,
    spanId: exemplar.spanId,
    ...(exemplar.traceFlags != null ? { traceFlags: exemplar.traceFlags } : {}),
    sampled: exemplar.sampled,
    ...(Object.keys(attributes.attributes).length > 0 ? { attributes: attributes.attributes } : {}),
  };
}
