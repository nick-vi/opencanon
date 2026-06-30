import { randomBytes } from 'node:crypto';
import {
  type Clock,
  type IdGenerator,
  type Logger,
  type ActiveSpan,
  type ActiveTrace,
  type ObservabilityExporter,
  type ObservationAttributes,
  type ObservationContext,
  type SpanInput,
  type SpanRecord,
  SpanKind,
  SpanStatus,
  type TraceEventRecord,
  type TraceRecord,
  TraceStatus,
  type Tracer,
  openTelemetrySpanKindFor,
  serializeObservedError,
} from '@opencanon/observability/ports';
import {
  assertObservabilityOpen,
  buildTraceContext,
  createContext,
  createParentBasedTraceSampler,
  formatTraceparent,
  isValidSpanId,
  isValidTraceId,
  isoTimestampEpochMs,
  millisecondsBetweenIsoTimestamps,
  positiveIntegerOption,
  samplingDecisionRecords,
  samplingDecisionSamples,
  type TelemetryResource,
  traceFlagsSampled,
  traceFlagsForSamplingDecision,
  type TraceSampler,
  unsampledTraceFlags,
} from '@opencanon/observability/primitives';

export type SimpleTracerOptions = {
  clock: Clock;
  ids: IdGenerator;
  exporters?: ObservabilityExporter[];
  maxActiveTraces?: number;
  staleTraceTtlMs?: number;
  sampler?: TraceSampler | undefined;
  traceState?: string;
  resource?: TelemetryResource | undefined;
};

type ExporterMethod = 'onTraceStart' | 'onTraceEnd' | 'onSpanStart' | 'onSpanEnd' | 'onEvent';

type ExporterPayload = TraceRecord | SpanRecord | TraceEventRecord;

type ActiveTraceState = {
  trace: TraceRecord;
  createdAtMs: number;
};

type ActiveSpanState = {
  span: SpanRecord;
  output?: ObservationAttributes;
};

const DEFAULT_MAX_ACTIVE_TRACES = 1000;
const DEFAULT_STALE_TRACE_TTL_MS = 10 * 60 * 1000;

export class SimpleTracer implements Tracer {
  private readonly clock: Clock;
  private readonly ids: IdGenerator;
  private readonly exporters: ObservabilityExporter[];
  private readonly maxActiveTraces: number;
  private readonly staleTraceTtlMs: number;
  private readonly sampler: TraceSampler;
  private readonly traceState: string | undefined;
  private readonly resource: TelemetryResource | undefined;
  private readonly context = createContext<ObservationContext>({ name: 'observability' });
  private readonly activeTraces = new Map<string, ActiveTraceState>();
  private readonly activeSpans = new Map<string, ActiveSpanState>();
  private readonly pendingExports = new Set<Promise<void>>();
  private readonly logger: Logger;
  private closed = false;

  constructor(
    logger: Logger,
    options: SimpleTracerOptions
  ) {
    this.logger = logger;
    this.clock = options.clock;
    this.ids = options.ids;
    this.exporters = options.exporters ?? [];
    this.maxActiveTraces = positiveIntegerOption(
      'maxActiveTraces',
      options.maxActiveTraces ?? DEFAULT_MAX_ACTIVE_TRACES
    );
    this.staleTraceTtlMs = positiveIntegerOption(
      'staleTraceTtlMs',
      options.staleTraceTtlMs ?? DEFAULT_STALE_TRACE_TTL_MS
    );
    this.sampler = options.sampler ?? createParentBasedTraceSampler();
    this.traceState = options.traceState;
    this.resource = options.resource;
  }

  async trace<T>(
    name: string,
    attributes: ObservationAttributes,
    fn: (trace: ActiveTrace) => Promise<T> | T
  ): Promise<T> {
    assertObservabilityOpen(this.closed, 'SimpleTracer');
    await this.pruneActiveTraces();
    await this.enforceActiveTraceLimit();

    const parent = this.context.tryUse();
    const traceId = nextTraceId();
    const sampling = this.sampler.shouldSample({
      traceId,
      name,
      kind: SpanKind.INTERNAL,
      attributes,
      traceState: parent?.traceState ?? this.traceState,
      ...(parent != null ? { parent } : {}),
    });
    const recording = samplingDecisionRecords(sampling.decision);
    const sampled = samplingDecisionSamples(sampling.decision);
    const traceFlags = traceFlagsForSamplingDecision(sampling.decision);
    const traceState = sampling.traceState ?? parent?.traceState ?? this.traceState;
    const traceAttributes = { ...attributes, ...(sampling.attributes ?? {}) };
    const startedAt = this.clock.now();
    const trace: TraceRecord = {
      id: traceId,
      name,
      status: TraceStatus.IN_PROGRESS,
      recording,
      sampled,
      startedAt,
      attributes: traceAttributes,
      ...(this.resource != null ? { resource: this.resource } : {}),
      ...(parent?.traceId != null ? { parentTraceId: parent.traceId } : {}),
      ...(traceState != null ? { traceState } : {}),
      traceFlags,
    };
    const context = buildContext({
      traceId: trace.id,
      parentTraceId: trace.parentTraceId,
      traceFlags,
      traceState,
      recording,
    });

    if (recording) {
      this.activeTraces.set(trace.id, {
        trace,
        createdAtMs: epochMillisecondsForTimestamp(startedAt),
      });
      await this.notifyExporters('onTraceStart', trace);
      this.logger.debug('Trace started', { traceId: trace.id, trace: name, ...traceAttributes });
    }

    let status: TraceStatus = TraceStatus.OK;
    let failure: unknown;
    try {
      return await this.context.provide(context, () =>
        fn(this.createTraceHandle(trace.id, context, recording, sampled))
      );
    } catch (error) {
      status = TraceStatus.ERROR;
      failure = error;
      throw error;
    } finally {
      await this.endTrace(trace.id, status, failure);
    }
  }

  async span<T>(
    name: string,
    input: SpanInput,
    fn: (span: ActiveSpan) => Promise<T> | T
  ): Promise<T> {
    assertObservabilityOpen(this.closed, 'SimpleTracer');
    const options = normalizeSpanInput(input);
    const current = this.context.tryUse();
    if (current == null) {
      return this.trace(name, options.attributes, (trace) => trace.span(name, options, fn));
    }

    const sampling = this.sampler.shouldSample({
      traceId: current.traceId,
      name,
      kind: options.kind,
      attributes: options.attributes,
      traceState: current.traceState ?? this.traceState,
      parent: current,
    });
    const recording = samplingDecisionRecords(sampling.decision);
    const sampled = samplingDecisionSamples(sampling.decision);
    const traceFlags = traceFlagsForSamplingDecision(sampling.decision);
    const traceState = sampling.traceState ?? current.traceState ?? this.traceState;
    const spanId = nextSpanId();
    const w3cContext = buildTraceContext({
      traceId: current.traceId,
      parentId: spanId,
      traceFlags,
      traceState,
    });
    const span: SpanRecord = {
      id: spanId,
      traceId: current.traceId,
      name,
      kind: options.kind,
      otelKind: openTelemetrySpanKindFor(options.kind),
      status: SpanStatus.IN_PROGRESS,
      recording,
      startedAt: this.clock.now(),
      attributes: { ...options.attributes, ...(sampling.attributes ?? {}) },
      ...(this.resource != null ? { resource: this.resource } : {}),
      ...(current.spanId != null ? { parentSpanId: current.spanId } : {}),
      traceParent: formatTraceparent(w3cContext),
      ...(traceState != null ? { traceState } : {}),
      traceFlags,
      sampled,
    };
    const context = buildContext({
      traceId: span.traceId,
      spanId: span.id,
      parentSpanId: span.parentSpanId,
      parentTraceId: current.parentTraceId,
      traceFlags,
      traceState,
      recording,
    });

    if (recording) {
      this.activeSpans.set(span.id, { span });
      await this.notifyExporters('onSpanStart', span);
      this.logger.debug('Span started', {
        traceId: span.traceId,
        spanId: span.id,
        parentSpanId: span.parentSpanId,
        span: name,
        kind: span.kind,
        ...span.attributes,
      });
    }

    try {
      const result = await this.context.provide(context, () => fn(this.createSpanHandle(span)));
      await this.endSpan(span.id, SpanStatus.OK);
      return result;
    } catch (error) {
      await this.endSpan(span.id, SpanStatus.ERROR, error);
      throw error;
    }
  }

  addEvent(name: string, attributes?: ObservationAttributes): TraceEventRecord | undefined {
    const current = this.context.tryUse();
    if (current == null) return undefined;
    if (current.recording === false) return undefined;
    return this.addEventToContext(current, name, attributes);
  }

  getCurrentContext(): ObservationContext | undefined {
    return this.context.tryUse();
  }

  async forceFlush(): Promise<void> {
    assertObservabilityOpen(this.closed, 'SimpleTracer');
    await this.flushPendingExports();
    await Promise.all(this.exporters.map((exporter) => exporter.forceFlush?.()));
    await this.logger.flush?.();
  }

  async shutdown(): Promise<void> {
    if (this.closed) return;

    for (const trace of [...this.activeTraces.keys()]) {
      await this.endTrace(trace, TraceStatus.ERROR, new Error('Tracer shutdown with active trace'));
    }

    await this.flushPendingExports();
    await Promise.all(this.exporters.map((exporter) => exporter.shutdown?.()));
    await this.logger.flush?.();
    this.clear();
    this.closed = true;
  }

  getActiveTraceCount(): number {
    return this.activeTraces.size;
  }

  clear(): void {
    this.activeTraces.clear();
    this.activeSpans.clear();
  }

  private createTraceHandle(
    traceId: string,
    context: ObservationContext,
    recording: boolean,
    sampled: boolean
  ): ActiveTrace {
    return {
      id: traceId,
      recording,
      sampled,
      addEvent: (name, attributes) =>
        recording ? this.addEventToContext(context, name, attributes) : undefined,
      span: (name, attributes, fn) => this.span(name, attributes, fn),
      getContext: () => context,
    };
  }

  private createSpanHandle(span: SpanRecord): ActiveSpan {
    return {
      id: span.id,
      traceId: span.traceId,
      ...(span.parentSpanId != null ? { parentSpanId: span.parentSpanId } : {}),
      recording: span.recording,
      sampled: span.sampled,
      addEvent: (name, attributes) =>
        span.recording
          ? this.addEventToContext(
              buildContext({
                traceId: span.traceId,
                spanId: span.id,
                parentSpanId: span.parentSpanId,
                traceFlags: span.traceFlags,
                traceState: span.traceState,
                recording: span.recording,
              }),
              name,
              attributes
            )
          : undefined,
      setAttribute: (key, value) => {
        const active = this.activeSpans.get(span.id);
        if (active == null) return;
        active.span.attributes = { ...active.span.attributes, [key]: value };
      },
      setAttributes: (attributes) => {
        const active = this.activeSpans.get(span.id);
        if (active == null) return;
        active.span.attributes = { ...active.span.attributes, ...attributes };
      },
      setOutput: (output) => {
        const active = this.activeSpans.get(span.id);
        if (active == null) return;
        active.output = output;
      },
      getContext: () =>
        buildContext({
          traceId: span.traceId,
          spanId: span.id,
          parentSpanId: span.parentSpanId,
          traceFlags: span.traceFlags,
          traceState: span.traceState,
          recording: span.recording,
        }),
    };
  }

  private addEventToContext(
    context: ObservationContext,
    name: string,
    attributes?: ObservationAttributes
  ): TraceEventRecord {
    const event: TraceEventRecord = {
      id: this.ids.nextId('event'),
      traceId: context.traceId,
      name,
      occurredAt: this.clock.now(),
      ...(this.resource != null ? { resource: this.resource } : {}),
      ...(context.spanId != null ? { spanId: context.spanId } : {}),
      ...(context.traceFlags != null ? { traceFlags: context.traceFlags } : {}),
      ...(context.sampled != null ? { sampled: context.sampled } : {}),
      ...(attributes != null ? { attributes } : {}),
    };
    void this.notifyExporters('onEvent', event);
    return event;
  }

  private async endSpan(
    spanId: string,
    status: SpanStatus,
    error?: unknown
  ): Promise<void> {
    const state = this.activeSpans.get(spanId);
    if (state == null) return;

    this.activeSpans.delete(spanId);
    const endedAt = this.clock.now();
    const completed: SpanRecord = {
      ...state.span,
      status,
      endedAt,
      durationMs: durationBetween(state.span.startedAt, endedAt),
      ...(state.output != null ? { output: state.output } : {}),
      ...(error !== undefined ? { error: serializeObservedError(error) } : {}),
    };

    await this.notifyExporters('onSpanEnd', completed);
    const context = {
      traceId: completed.traceId,
      spanId: completed.id,
      span: completed.name,
      durationMs: completed.durationMs,
      ...completed.attributes,
    };

    if (status === SpanStatus.ERROR) {
      this.logger.error('Span failed', {
        ...context,
        error: completed.error,
      });
    } else {
      this.logger.debug('Span completed', context);
    }
  }

  private async endTrace(
    traceId: string,
    status: TraceStatus,
    error?: unknown
  ): Promise<void> {
    const state = this.activeTraces.get(traceId);
    if (state == null) return;

    for (const span of [...this.activeSpans.values()].filter(
      (item) => item.span.traceId === traceId
    )) {
      await this.endSpan(
        span.span.id,
        status === TraceStatus.ERROR ? SpanStatus.ERROR : SpanStatus.OK,
        error
      );
    }

    this.activeTraces.delete(traceId);
    const endedAt = this.clock.now();
    const completed: TraceRecord = {
      ...state.trace,
      status,
      endedAt,
      durationMs: durationBetween(state.trace.startedAt, endedAt),
      ...(error !== undefined ? { error: serializeObservedError(error) } : {}),
    };

    await this.notifyExporters('onTraceEnd', completed);

    const context = {
      traceId: completed.id,
      trace: completed.name,
      durationMs: completed.durationMs,
      ...completed.attributes,
    };

    if (status === TraceStatus.ERROR) {
      this.logger.error('Trace failed', {
        ...context,
        error: completed.error,
      });
    } else {
      this.logger.debug('Trace completed', context);
    }
  }

  private async notifyExporters(method: ExporterMethod, payload: ExporterPayload): Promise<void> {
    const awaited: Array<Promise<void>> = [];

    for (const exporter of this.exporters) {
      const callback = exporter[method];
      if (callback == null) continue;

      const execute = async () => {
        try {
          await (callback as (payload: ExporterPayload) => void | Promise<void>).call(
            exporter,
            payload
          );
        } catch (error) {
          this.logger.error('Observability exporter failed', {
            method,
            error: serializeObservedError(error),
          });
        }
      };

      if (exporter.awaited === true) {
        awaited.push(execute());
      } else {
        const pending = execute();
        this.pendingExports.add(pending);
        void pending.finally(() => this.pendingExports.delete(pending));
      }
    }

    if (awaited.length > 0) {
      await Promise.all(awaited);
    }
  }

  private async pruneActiveTraces(): Promise<void> {
    const cutoff = epochMillisecondsForTimestamp(this.clock.now()) - this.staleTraceTtlMs;
    for (const state of [...this.activeTraces.values()]) {
      if (state.createdAtMs < cutoff) {
        await this.endTrace(
          state.trace.id,
          TraceStatus.ERROR,
          new Error(`Trace exceeded stale TTL of ${this.staleTraceTtlMs}ms`)
        );
      }
    }
  }

  private async enforceActiveTraceLimit(): Promise<void> {
    while (this.activeTraces.size >= this.maxActiveTraces) {
      const oldest = [...this.activeTraces.values()].sort(
        (a, b) => a.createdAtMs - b.createdAtMs
      )[0];
      if (oldest == null) return;
      await this.endTrace(
        oldest.trace.id,
        TraceStatus.ERROR,
        new Error(`Trace evicted after active trace limit ${this.maxActiveTraces} was reached`)
      );
    }
  }

  private async flushPendingExports(): Promise<void> {
    if (this.pendingExports.size === 0) return;
    await Promise.all([...this.pendingExports]);
  }
}

function buildContext(input: {
  traceId: string;
  spanId?: string | undefined;
  parentSpanId?: string | undefined;
  parentTraceId?: string | undefined;
  traceFlags?: string | undefined;
  traceState?: string | undefined;
  recording?: boolean | undefined;
}): ObservationContext {
  const traceFlags = input.traceFlags ?? unsampledTraceFlags();
  const traceContext =
    input.spanId != null
      ? buildTraceContext({
          traceId: input.traceId,
          parentId: input.spanId,
          traceFlags,
          traceState: input.traceState,
        })
      : undefined;

  return {
    traceId: input.traceId,
    ...(input.spanId != null ? { spanId: input.spanId } : {}),
    ...(input.parentSpanId != null ? { parentSpanId: input.parentSpanId } : {}),
    ...(input.parentTraceId != null ? { parentTraceId: input.parentTraceId } : {}),
    ...(traceContext != null ? { traceParent: formatTraceparent(traceContext) } : {}),
    ...(input.traceState != null ? { traceState: input.traceState } : {}),
    traceFlags,
    sampled: traceContext?.sampled ?? traceFlagsSampled(traceFlags),
    ...(input.recording != null ? { recording: input.recording } : {}),
  };
}

function nextTraceId(): string {
  return nextValidHexId(16, isValidTraceId);
}

function nextSpanId(): string {
  return nextValidHexId(8, isValidSpanId);
}

function nextValidHexId(byteLength: number, isValid: (value: string) => boolean): string {
  for (;;) {
    const value = randomBytes(byteLength).toString('hex');
    if (isValid(value)) return value;
  }
}

function durationBetween(startedAt: string, endedAt: string): number {
  return Math.max(0, millisecondsBetweenIsoTimestamps(startedAt, endedAt).unwrap());
}

function epochMillisecondsForTimestamp(timestamp: string): number {
  const parsed = isoTimestampEpochMs(timestamp, 'clock.now');
  if (!parsed.ok) throw parsed.error;
  return parsed.value;
}

function normalizeSpanInput(input: SpanInput): { kind: SpanKind; attributes: ObservationAttributes } {
  if (isSpanOptions(input)) {
    return {
      kind: input.kind,
      attributes: input.attributes ?? {},
    };
  }

  return {
    kind: SpanKind.INTERNAL,
    attributes: input,
  };
}

function isSpanOptions(input: SpanInput): input is { kind: SpanKind; attributes?: ObservationAttributes } {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return false;
  const keys = Object.keys(input);
  if (!keys.every((key) => key === 'kind' || key === 'attributes')) return false;
  return Object.values(SpanKind).includes((input as { kind?: unknown }).kind as SpanKind);
}
