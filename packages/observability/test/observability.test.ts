import assert from "node:assert/strict";
import { test } from "vitest";
import {
  AlwaysOffTraceSampler,
  CorrelatedLogger,
  InMemoryMetricsRecorder,
  LogLevel,
  MetricKind,
  NoopLogger,
  SimpleTracer,
  SpanKind,
  extractTraceContext,
  injectTraceContext,
  metric,
  metricExemplarFromContext,
  serviceTelemetryResource,
  type Clock,
  type IdGenerator,
  type LogContext,
  type LogEntry,
  type Logger,
  type LoggerTransport,
  type ObservabilityExporter,
  type SpanRecord,
  type TraceEventRecord,
  type TraceRecord,
} from "../src/index.ts";

const TRACEPARENT_PATTERN = /^00-[0-9a-f]{32}-[0-9a-f]{16}-0[01]$/;

test("SimpleTracer records W3C-compatible traces, spans, events, and outputs", async () => {
  const collector = createTraceCollector();
  const tracer = new SimpleTracer(new NoopLogger(), {
    clock: new StepClock("2026-01-01T00:00:00.000Z"),
    ids: new SequentialIds(),
    exporters: [collector.exporter],
    resource: serviceTelemetryResource({ serviceName: "opencanon", serviceVersion: "0.4.0" }),
  });

  let spanContextTraceparent: string | undefined;
  await tracer.span(
    "index.graph.rebuild",
    { kind: SpanKind.TASK, attributes: { projectId: "demo" } },
    (span) => {
      span.setAttribute("phase", "walk");
      span.setOutput({ files: 3 });
      spanContextTraceparent = span.getContext().traceParent;

      const event = span.addEvent("files.discovered", { count: 3 });
      assert.equal(event?.id, "event_1");
      assert.equal(event?.spanId, span.id);
    },
  );

  await tracer.forceFlush();

  assert.equal(collector.tracesStarted.length, 1);
  assert.equal(collector.tracesEnded.length, 1);
  assert.equal(collector.spansStarted.length, 1);
  assert.equal(collector.spansEnded.length, 1);
  assert.equal(collector.events.length, 1);
  assert.equal(tracer.getActiveTraceCount(), 0);

  const [span] = collector.spansEnded;
  assert.match(span.traceParent, TRACEPARENT_PATTERN);
  assert.equal(spanContextTraceparent, span.traceParent);
  assert.equal(span.kind, SpanKind.TASK);
  assert.equal(span.sampled, true);
  assert.equal(span.traceFlags, "01");
  assert.deepEqual(span.attributes, { projectId: "demo", phase: "walk" });
  assert.deepEqual(span.output, { files: 3 });

  const [trace] = collector.tracesEnded;
  assert.equal(trace.id, span.traceId);
  assert.equal(trace.sampled, true);
  assert.equal(trace.resource?.attributes["service.name"], "opencanon");
});

test("SimpleTracer keeps async span contexts isolated under one trace", async () => {
  const collector = createTraceCollector();
  const tracer = new SimpleTracer(new NoopLogger(), {
    clock: new StepClock("2026-01-01T00:00:00.000Z"),
    ids: new SequentialIds(),
    exporters: [collector.exporter],
  });

  const seen = new Map<string, string | undefined>();
  await tracer.trace("root", {}, async (trace) => {
    await Promise.all([
      trace.span("left", { kind: SpanKind.INTERNAL }, async (span) => {
        await Promise.resolve();
        seen.set("left", tracer.getCurrentContext()?.spanId);
        assert.equal(tracer.getCurrentContext()?.spanId, span.id);
      }),
      trace.span("right", { kind: SpanKind.INTERNAL }, async (span) => {
        await Promise.resolve();
        seen.set("right", tracer.getCurrentContext()?.spanId);
        assert.equal(tracer.getCurrentContext()?.spanId, span.id);
      }),
    ]);
  });

  assert.equal(collector.spansEnded.length, 2);
  assert.notEqual(seen.get("left"), seen.get("right"));
  assert.equal(new Set(collector.spansEnded.map((span) => span.traceId)).size, 1);
});

test("AlwaysOffTraceSampler propagates unsampled context without exporting records", async () => {
  const collector = createTraceCollector();
  const tracer = new SimpleTracer(new NoopLogger(), {
    clock: new StepClock("2026-01-01T00:00:00.000Z"),
    ids: new SequentialIds(),
    exporters: [collector.exporter],
    sampler: AlwaysOffTraceSampler,
  });

  let contextTraceFlags: string | undefined;
  await tracer.span("hidden", { kind: SpanKind.INTERNAL }, (span) => {
    contextTraceFlags = span.getContext().traceFlags;
    assert.equal(span.recording, false);
    assert.equal(span.sampled, false);
    assert.equal(span.addEvent("ignored"), undefined);
  });

  await tracer.forceFlush();
  assert.equal(contextTraceFlags, "00");
  assert.equal(collector.tracesStarted.length, 0);
  assert.equal(collector.tracesEnded.length, 0);
  assert.equal(collector.spansStarted.length, 0);
  assert.equal(collector.spansEnded.length, 0);
  assert.equal(collector.events.length, 0);
});

test("trace context extraction and injection accept case-insensitive carriers", () => {
  const extracted = extractTraceContext({
    TraceParent: "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
    TraceState: "vendor=value",
  });
  assert.equal(extracted.ok, true);
  if (!extracted.ok) return;

  const injected = injectTraceContext({}, extracted.value);
  assert.equal(injected.ok, true);
  if (!injected.ok) return;

  assert.equal(
    injected.value.traceparent,
    "00-1234567890abcdef1234567890abcdef-1234567890abcdef-01",
  );
  assert.equal(injected.value.tracestate, "vendor=value");
});

test("metrics normalize overflow attributes and attach trace exemplars", async () => {
  const clock = new StepClock("2026-01-01T00:00:00.000Z");
  const recorder = new InMemoryMetricsRecorder();
  const normalized = metric(
    {
      name: "index.files",
      kind: MetricKind.Counter,
      value: 3,
      observedAt: clock.now(),
      attributes: { a: 1, b: 2, c: 3 },
    },
    { maxAttributes: 2 },
  );

  assert.deepEqual(normalized.attributes, { a: 1, "otel.metric.overflow": true });
  assert.equal(normalized.droppedAttributes, 2);

  const tracer = new SimpleTracer(new NoopLogger(), {
    clock,
    ids: new SequentialIds(),
  });
  await tracer.span("measure", { kind: SpanKind.INTERNAL }, async (span) => {
    await recorder.record({
      name: "index.duration",
      kind: MetricKind.Duration,
      value: 12,
      observedAt: clock.now(),
      exemplar: metricExemplarFromContext(span.getContext(), {
        value: 12,
        observedAt: clock.now(),
      }),
    });
  });

  const [measurement] = await recorder.list({ name: "index.duration" });
  assert.equal(measurement.exemplar?.sampled, true);
  assert.match(measurement.exemplar?.traceId ?? "", /^[0-9a-f]{32}$/);
  assert.match(measurement.exemplar?.spanId ?? "", /^[0-9a-f]{16}$/);
});

test("CorrelatedLogger adds active trace bindings to log entries", async () => {
  const transport = new CaptureTransport();
  const logger = new CaptureLogger(transport);
  const tracer = new SimpleTracer(new NoopLogger(), {
    clock: new StepClock("2026-01-01T00:00:00.000Z"),
    ids: new SequentialIds(),
  });
  const correlated = new CorrelatedLogger(logger, tracer);

  await tracer.span("logged", { kind: SpanKind.INTERNAL }, () => {
    correlated.info("ready", { component: "indexer" });
  });

  assert.equal(transport.entries.length, 1);
  const [entry] = transport.entries;
  assert.equal(entry.message, "ready");
  assert.equal(entry.component, "indexer");
  assert.match(String(entry.traceId), /^[0-9a-f]{32}$/);
  assert.match(String(entry.spanId), /^[0-9a-f]{16}$/);
  assert.match(String(entry.traceparent), TRACEPARENT_PATTERN);
});

function createTraceCollector(): {
  exporter: ObservabilityExporter;
  tracesStarted: TraceRecord[];
  tracesEnded: TraceRecord[];
  spansStarted: SpanRecord[];
  spansEnded: SpanRecord[];
  events: TraceEventRecord[];
} {
  const tracesStarted: TraceRecord[] = [];
  const tracesEnded: TraceRecord[] = [];
  const spansStarted: SpanRecord[] = [];
  const spansEnded: SpanRecord[] = [];
  const events: TraceEventRecord[] = [];

  return {
    tracesStarted,
    tracesEnded,
    spansStarted,
    spansEnded,
    events,
    exporter: {
      awaited: true,
      onTraceStart(trace) {
        tracesStarted.push(structuredClone(trace));
      },
      onTraceEnd(trace) {
        tracesEnded.push(structuredClone(trace));
      },
      onSpanStart(span) {
        spansStarted.push(structuredClone(span));
      },
      onSpanEnd(span) {
        spansEnded.push(structuredClone(span));
      },
      onEvent(event) {
        events.push(structuredClone(event));
      },
    },
  };
}

class StepClock implements Clock {
  private epochMs: number;

  constructor(start: string) {
    this.epochMs = Date.parse(start);
  }

  now(): string {
    const value = new Date(this.epochMs).toISOString();
    this.epochMs += 5;
    return value;
  }
}

class SequentialIds implements IdGenerator {
  private next = 1;

  nextId(prefix: string): string {
    return `${prefix}_${this.next++}`;
  }
}

class CaptureTransport implements LoggerTransport {
  readonly entries: LogEntry[] = [];

  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

class CaptureLogger implements Logger {
  private readonly context: LogContext;
  private readonly transport: CaptureTransport;

  constructor(
    transport: CaptureTransport,
    context: LogContext = {},
  ) {
    this.transport = transport;
    this.context = context;
  }

  trace(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LogLevel.TRACE, input, messageOrContext);
  }

  debug(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LogLevel.DEBUG, input, messageOrContext);
  }

  info(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LogLevel.INFO, input, messageOrContext);
  }

  warn(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LogLevel.WARN, input, messageOrContext);
  }

  error(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LogLevel.ERROR, input, messageOrContext);
  }

  fatal(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LogLevel.FATAL, input, messageOrContext);
  }

  child(bindings: LogContext): Logger {
    return new CaptureLogger(this.transport, { ...this.context, ...bindings });
  }

  private write(levelLabel: LogLevel, input: unknown, messageOrContext?: string | LogContext): void {
    const context =
      typeof input === "string"
        ? typeof messageOrContext === "object" && messageOrContext !== null
          ? messageOrContext
          : {}
        : typeof input === "object" && input !== null
          ? (input as LogContext)
          : { value: input };
    const message = typeof input === "string" ? input : typeof messageOrContext === "string" ? messageOrContext : "";
    this.transport.write({
      ...this.context,
      ...context,
      level: 30,
      levelLabel,
      time: "2026-01-01T00:00:00.000Z",
      message,
    });
  }
}
