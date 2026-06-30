import type {
  ActiveSpan,
  ActiveTrace,
  ObservationAttributes,
  ObservationContext,
  SpanInput,
  TraceEventRecord,
  Tracer,
} from '@opencanon/observability/ports';
import { buildTraceContext, formatTraceparent, unsampledTraceFlags } from '@opencanon/observability/primitives';

const NOOP_TRACE_ID = '00000000000000000000000000000001';
const NOOP_SPAN_ID = '0000000000000001';
const NOOP_TRACE_FLAGS = unsampledTraceFlags();
const NOOP_TRACE_PARENT = formatTraceparent(
  buildTraceContext({
    traceId: NOOP_TRACE_ID,
    parentId: NOOP_SPAN_ID,
    traceFlags: NOOP_TRACE_FLAGS,
  })
);

export class NoopTracer implements Tracer {
  async trace<T>(
    _name: string,
    _attributes: ObservationAttributes,
    fn: (trace: ActiveTrace) => Promise<T> | T
  ): Promise<T> {
    return fn(createNoopTrace(this));
  }

  async span<T>(
    _name: string,
    _input: SpanInput,
    fn: (span: ActiveSpan) => Promise<T> | T
  ): Promise<T> {
    return fn(createNoopSpan());
  }

  addEvent(): TraceEventRecord | undefined {
    return undefined;
  }

  getCurrentContext(): ObservationContext | undefined {
    return undefined;
  }

  async forceFlush(): Promise<void> {}

  async shutdown(): Promise<void> {}
}

function createNoopTrace(tracer: NoopTracer): ActiveTrace {
  return {
    id: NOOP_TRACE_ID,
    recording: false,
    sampled: false,
    addEvent: () => undefined,
    span: (name, attributes, fn) => tracer.span(name, attributes, fn),
    getContext: () => ({
      traceId: NOOP_TRACE_ID,
      traceFlags: NOOP_TRACE_FLAGS,
      sampled: false,
      recording: false,
    }),
  };
}

function createNoopSpan(): ActiveSpan {
  return {
    id: NOOP_SPAN_ID,
    traceId: NOOP_TRACE_ID,
    recording: false,
    sampled: false,
    addEvent: () => undefined,
    setAttribute: () => {},
    setAttributes: () => {},
    setOutput: () => {},
    getContext: () => ({
      traceId: NOOP_TRACE_ID,
      spanId: NOOP_SPAN_ID,
      traceParent: NOOP_TRACE_PARENT,
      traceFlags: NOOP_TRACE_FLAGS,
      sampled: false,
      recording: false,
    }),
  };
}
