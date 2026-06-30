import type { TelemetryResource } from '../primitives/telemetry-resource.ts';

export type ObservationAttributes = Record<string, unknown>;

export type SpanOptions = {
  kind: SpanKind;
  attributes?: ObservationAttributes | undefined;
};

export type SpanInput = ObservationAttributes | SpanOptions;

export const TraceStatus = Object.freeze({
  IN_PROGRESS: 'in_progress',
  OK: 'ok',
  ERROR: 'error',
} as const);

export type TraceStatus = (typeof TraceStatus)[keyof typeof TraceStatus];

export const SpanStatus = Object.freeze({
  IN_PROGRESS: 'in_progress',
  OK: 'ok',
  ERROR: 'error',
} as const);

export type SpanStatus = (typeof SpanStatus)[keyof typeof SpanStatus];

export const SpanKind = Object.freeze({
  INTERNAL: 'internal',
  SERVER: 'server',
  CLIENT: 'client',
  PRODUCER: 'producer',
  CONSUMER: 'consumer',
  EVENT_EMIT: 'event_emit',
  EVENT_HANDLE: 'event_handle',
  COMPONENT: 'component',
  HTTP: 'http',
  DB: 'db',
  LLM: 'llm',
  TASK: 'task',
} as const);

export type SpanKind = (typeof SpanKind)[keyof typeof SpanKind];

export const OpenTelemetrySpanKind = Object.freeze({
  INTERNAL: 'INTERNAL',
  SERVER: 'SERVER',
  CLIENT: 'CLIENT',
  PRODUCER: 'PRODUCER',
  CONSUMER: 'CONSUMER',
} as const);

export type OpenTelemetrySpanKind =
  (typeof OpenTelemetrySpanKind)[keyof typeof OpenTelemetrySpanKind];

export type ObservedError = {
  message: string;
  name: string;
  stack?: string;
  cause?: ObservedError;
  [key: string]: unknown;
};

export type ObservationContext = {
  traceId: string;
  spanId?: string;
  parentSpanId?: string;
  parentTraceId?: string;
  traceParent?: string;
  traceState?: string;
  traceFlags?: string;
  sampled?: boolean;
  recording?: boolean;
};

export type TraceRecord = {
  id: string;
  name: string;
  status: TraceStatus;
  recording: boolean;
  sampled: boolean;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attributes: ObservationAttributes;
  resource?: TelemetryResource | undefined;
  parentTraceId?: string;
  traceState?: string;
  traceFlags?: string;
  error?: ObservedError;
};

export type SpanRecord = {
  id: string;
  traceId: string;
  parentSpanId?: string;
  name: string;
  kind: SpanKind;
  otelKind: OpenTelemetrySpanKind;
  status: SpanStatus;
  recording: boolean;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  attributes: ObservationAttributes;
  resource?: TelemetryResource | undefined;
  traceParent: string;
  traceState?: string;
  traceFlags: string;
  sampled: boolean;
  output?: ObservationAttributes;
  error?: ObservedError;
};

export type TraceEventRecord = {
  id: string;
  traceId: string;
  spanId?: string;
  name: string;
  occurredAt: string;
  resource?: TelemetryResource | undefined;
  traceFlags?: string | undefined;
  sampled?: boolean | undefined;
  attributes?: ObservationAttributes;
};

export type ObservabilityExporter = {
  awaited?: boolean;
  onTraceStart?(trace: TraceRecord): void | Promise<void>;
  onTraceEnd?(trace: TraceRecord): void | Promise<void>;
  onSpanStart?(span: SpanRecord): void | Promise<void>;
  onSpanEnd?(span: SpanRecord): void | Promise<void>;
  onEvent?(event: TraceEventRecord): void | Promise<void>;
  forceFlush?(): void | Promise<void>;
  shutdown?(): void | Promise<void>;
};

export type TraceExporter = ObservabilityExporter;

export type ActiveSpan = {
  readonly id: string;
  readonly traceId: string;
  readonly parentSpanId?: string;
  readonly recording: boolean;
  readonly sampled: boolean;
  addEvent(name: string, attributes?: ObservationAttributes): TraceEventRecord | undefined;
  setAttribute(key: string, value: unknown): void;
  setAttributes(attributes: ObservationAttributes): void;
  setOutput(output: ObservationAttributes): void;
  getContext(): ObservationContext;
};

export type ActiveTrace = {
  readonly id: string;
  readonly recording: boolean;
  readonly sampled: boolean;
  addEvent(name: string, attributes?: ObservationAttributes): TraceEventRecord | undefined;
  span<T>(
    name: string,
    input: SpanInput,
    fn: (span: ActiveSpan) => Promise<T> | T
  ): Promise<T>;
  getContext(): ObservationContext;
};

export interface Tracer {
  trace<T>(
    name: string,
    attributes: ObservationAttributes,
    fn: (trace: ActiveTrace) => Promise<T> | T
  ): Promise<T>;

  span<T>(
    name: string,
    input: SpanInput,
    fn: (span: ActiveSpan) => Promise<T> | T
  ): Promise<T>;

  addEvent(name: string, attributes?: ObservationAttributes): TraceEventRecord | undefined;
  getCurrentContext(): ObservationContext | undefined;
  forceFlush(): Promise<void>;
  shutdown(): Promise<void>;
}

export function traceStatusForSpanStatus(status: SpanStatus): TraceStatus {
  return status === SpanStatus.ERROR ? TraceStatus.ERROR : TraceStatus.OK;
}

export function openTelemetrySpanKindFor(kind: SpanKind): OpenTelemetrySpanKind {
  switch (kind) {
    case SpanKind.SERVER:
      return OpenTelemetrySpanKind.SERVER;
    case SpanKind.CLIENT:
    case SpanKind.HTTP:
    case SpanKind.DB:
      return OpenTelemetrySpanKind.CLIENT;
    case SpanKind.PRODUCER:
    case SpanKind.EVENT_EMIT:
      return OpenTelemetrySpanKind.PRODUCER;
    case SpanKind.CONSUMER:
    case SpanKind.EVENT_HANDLE:
      return OpenTelemetrySpanKind.CONSUMER;
    case SpanKind.INTERNAL:
    case SpanKind.COMPONENT:
    case SpanKind.LLM:
    case SpanKind.TASK:
      return OpenTelemetrySpanKind.INTERNAL;
  }
}

export function serializeObservedError(error: unknown, depth = 0): ObservedError {
  if (error instanceof Error) {
    const serialized: ObservedError = {
      message: error.message,
      name: error.name,
      ...(error.stack != null ? { stack: error.stack } : {}),
    };

    if ('cause' in error && error.cause !== undefined && depth < 10) {
      serialized.cause = serializeObservedError(error.cause, depth + 1);
    }

    for (const key of Object.keys(error)) {
      const value = (error as unknown as ObservationAttributes)[key];
      if (value !== undefined && typeof value !== 'function' && !(key in serialized)) {
        serialized[key] = value;
      }
    }

    return serialized;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as ObservationAttributes;
    return {
      message: String(candidate.message ?? 'Unknown error'),
      name: String(candidate.name ?? 'Error'),
      ...candidate,
    };
  }

  return {
    message: String(error),
    name: 'Error',
  };
}
