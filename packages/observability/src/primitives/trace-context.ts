import { Err, Ok, type Result } from './result.ts';
import {
  BAGGAGE_HEADER,
  type Baggage,
  type BaggageError,
  formatBaggage,
  parseBaggage,
} from './baggage.ts';

export const TRACE_CONTEXT_VERSION = '00';
export const TRACE_CONTEXT_SAMPLED_FLAG = 0x01;

export type TraceContext = {
  version: string;
  traceId: string;
  parentId: string;
  traceFlags: string;
  sampled: boolean;
  traceState?: string | undefined;
};

export type TraceContextInput = {
  traceId: string;
  parentId: string;
  traceFlags?: string | undefined;
  sampled?: boolean | undefined;
  traceState?: string | undefined;
};

export type TraceContextCarrierValue = string | readonly string[] | undefined;
export type TraceContextCarrier = Record<string, TraceContextCarrierValue>;

export type PropagatedTraceContext = {
  traceContext?: TraceContext | undefined;
  baggage?: Baggage | undefined;
};

export const TraceContextErrorKind = Object.freeze({
  InvalidTraceparent: 'invalid_traceparent',
  UnsupportedVersion: 'unsupported_version',
  InvalidTraceId: 'invalid_trace_id',
  InvalidParentId: 'invalid_parent_id',
  InvalidTraceFlags: 'invalid_trace_flags',
} as const);

export type TraceContextErrorKind =
  (typeof TraceContextErrorKind)[keyof typeof TraceContextErrorKind];

export class TraceContextError extends Error {
  override readonly name = 'TraceContextError';
  readonly kind: TraceContextErrorKind;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    kind: TraceContextErrorKind,
    message: string,
    details?: Record<string, unknown> | undefined
  ) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

export class TracePropagationError extends Error {
  override readonly name = 'TracePropagationError';
  override readonly cause: TraceContextError | BaggageError;

  constructor(
    message: string,
    cause: TraceContextError | BaggageError
  ) {
    super(message, { cause });
    this.cause = cause;
  }
}

const LOWER_HEX_32 = /^[0-9a-f]{32}$/;
const LOWER_HEX_16 = /^[0-9a-f]{16}$/;
const LOWER_HEX_2 = /^[0-9a-f]{2}$/;

export function isValidTraceId(traceId: string): boolean {
  return LOWER_HEX_32.test(traceId) && !isAllZero(traceId);
}

export function isValidSpanId(spanId: string): boolean {
  return LOWER_HEX_16.test(spanId) && !isAllZero(spanId);
}

export function isValidTraceFlags(traceFlags: string): boolean {
  return LOWER_HEX_2.test(traceFlags);
}

export function parseTraceparent(
  traceparent: string,
  traceState?: string | undefined
): Result<TraceContext, TraceContextError> {
  const parts = traceparent.split('-');
  if (parts.length !== 4) {
    return Err(
      new TraceContextError(
        TraceContextErrorKind.InvalidTraceparent,
        'Traceparent must contain version, trace-id, parent-id, and trace-flags',
        { traceparent }
      )
    );
  }

  const [version, traceId, parentId, traceFlags] = parts as [string, string, string, string];
  if (version === 'ff' || !isValidTraceFlags(version)) {
    return Err(
      new TraceContextError(TraceContextErrorKind.UnsupportedVersion, 'Traceparent version is invalid', {
        version,
      })
    );
  }

  if (version !== TRACE_CONTEXT_VERSION) {
    return Err(
      new TraceContextError(
        TraceContextErrorKind.UnsupportedVersion,
        `Traceparent version "${version}" is not supported`,
        { version }
      )
    );
  }

  if (!isValidTraceId(traceId)) {
    return Err(
      new TraceContextError(TraceContextErrorKind.InvalidTraceId, 'Trace id is invalid', {
        traceId,
      })
    );
  }

  if (!isValidSpanId(parentId)) {
    return Err(
      new TraceContextError(TraceContextErrorKind.InvalidParentId, 'Parent id is invalid', {
        parentId,
      })
    );
  }

  if (!isValidTraceFlags(traceFlags)) {
    return Err(
      new TraceContextError(TraceContextErrorKind.InvalidTraceFlags, 'Trace flags are invalid', {
        traceFlags,
      })
    );
  }

  return Ok(buildTraceContext({ traceId, parentId, traceFlags, traceState }));
}

export function extractTraceContext(
  carrier: TraceContextCarrier
): Result<PropagatedTraceContext, TracePropagationError> {
  const traceparent = carrierValue(carrier, 'traceparent');
  const tracestate = carrierValue(carrier, 'tracestate');
  const baggageHeader = carrierValue(carrier, BAGGAGE_HEADER);
  const output: PropagatedTraceContext = {};

  if (traceparent != null) {
    const traceparentValue = Array.isArray(traceparent) ? traceparent[0] : traceparent;
    if (traceparentValue == null) {
      return Err(
        new TracePropagationError(
          'Traceparent extraction failed',
          new TraceContextError(
            TraceContextErrorKind.InvalidTraceparent,
            'Traceparent header is empty'
          )
        )
      );
    }
    const parsed = parseTraceparent(
      traceparentValue,
      typeof tracestate === 'string'
        ? tracestate
        : tracestate != null
          ? tracestate.join(',')
          : undefined
    );
    if (!parsed.ok) {
      return Err(new TracePropagationError('Traceparent extraction failed', parsed.error));
    }
    output.traceContext = parsed.value;
  }

  if (baggageHeader != null) {
    const parsed = parseBaggage(baggageHeader);
    if (!parsed.ok) {
      return Err(new TracePropagationError('Baggage extraction failed', parsed.error));
    }
    output.baggage = parsed.value;
  }

  return Ok(output);
}

export function injectTraceContext(
  carrier: TraceContextCarrier,
  context: PropagatedTraceContext
): Result<TraceContextCarrier, TracePropagationError> {
  const next = { ...carrier };
  if (context.traceContext != null) {
    next.traceparent = formatTraceparent(context.traceContext);
    if (context.traceContext.traceState != null) {
      next.tracestate = context.traceContext.traceState;
    }
  }

  if (context.baggage != null) {
    const formatted = formatBaggage(context.baggage);
    if (!formatted.ok) {
      return Err(new TracePropagationError('Baggage injection failed', formatted.error));
    }
    if (formatted.value.length > 0) {
      next[BAGGAGE_HEADER] = formatted.value;
    }
  }

  return Ok(next);
}

export function buildTraceContext(input: TraceContextInput): TraceContext {
  const traceFlags =
    input.traceFlags ?? (input.sampled === true ? sampledTraceFlags() : unsampledTraceFlags());

  assertTraceContextIds(input.traceId, input.parentId, traceFlags);

  return {
    version: TRACE_CONTEXT_VERSION,
    traceId: input.traceId,
    parentId: input.parentId,
    traceFlags,
    sampled: traceFlagsSampled(traceFlags),
    ...(input.traceState != null ? { traceState: input.traceState } : {}),
  };
}

export function formatTraceparent(context: TraceContext): string {
  assertTraceContextIds(context.traceId, context.parentId, context.traceFlags);
  return `${context.version}-${context.traceId}-${context.parentId}-${context.traceFlags}`;
}

export function traceFlagsSampled(traceFlags: string): boolean {
  if (!isValidTraceFlags(traceFlags)) {
    throw new TraceContextError(TraceContextErrorKind.InvalidTraceFlags, 'Trace flags are invalid', {
      traceFlags,
    });
  }

  return (Number.parseInt(traceFlags, 16) & TRACE_CONTEXT_SAMPLED_FLAG) === TRACE_CONTEXT_SAMPLED_FLAG;
}

export function sampledTraceFlags(): string {
  return TRACE_CONTEXT_SAMPLED_FLAG.toString(16).padStart(2, '0');
}

export function unsampledTraceFlags(): string {
  return '00';
}

function assertTraceContextIds(traceId: string, parentId: string, traceFlags: string): void {
  if (!isValidTraceId(traceId)) {
    throw new TraceContextError(TraceContextErrorKind.InvalidTraceId, 'Trace id is invalid', {
      traceId,
    });
  }
  if (!isValidSpanId(parentId)) {
    throw new TraceContextError(TraceContextErrorKind.InvalidParentId, 'Parent id is invalid', {
      parentId,
    });
  }
  if (!isValidTraceFlags(traceFlags)) {
    throw new TraceContextError(TraceContextErrorKind.InvalidTraceFlags, 'Trace flags are invalid', {
      traceFlags,
    });
  }
}

function isAllZero(value: string): boolean {
  return /^0+$/.test(value);
}

function carrierValue(carrier: TraceContextCarrier, key: string): string | readonly string[] | undefined {
  const direct = carrier[key];
  if (direct != null) return direct;
  const lower = key.toLowerCase();
  const matchingKey = Object.keys(carrier).find((candidate) => candidate.toLowerCase() === lower);
  return matchingKey == null ? undefined : carrier[matchingKey];
}
