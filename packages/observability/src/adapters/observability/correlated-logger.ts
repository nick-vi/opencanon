import type { LogContext, Logger, ObservationContext, Tracer } from '@opencanon/observability/ports';

type LogMethod = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const CorrelatedLogKind = {
  Data: 'data',
  Message: 'message',
} as const;

type NormalizedCorrelatedLog =
  | {
      kind: typeof CorrelatedLogKind.Message;
      message: string;
      context?: LogContext | undefined;
    }
  | {
      kind: typeof CorrelatedLogKind.Data;
      data: unknown;
      message?: string | undefined;
    };

export class CorrelatedLogger implements Logger {
  private readonly logger: Logger;
  private readonly tracer: Pick<Tracer, 'getCurrentContext'>;

  constructor(
    logger: Logger,
    tracer: Pick<Tracer, 'getCurrentContext'>
  ) {
    this.logger = logger;
    this.tracer = tracer;
  }

  trace(message: string, context?: LogContext): void;
  trace(context: unknown, message?: string): void;
  trace(input: unknown, messageOrContext?: string | LogContext): void {
    this.write('trace', input, messageOrContext);
  }

  debug(message: string, context?: LogContext): void;
  debug(context: unknown, message?: string): void;
  debug(input: unknown, messageOrContext?: string | LogContext): void {
    this.write('debug', input, messageOrContext);
  }

  info(message: string, context?: LogContext): void;
  info(context: unknown, message?: string): void;
  info(input: unknown, messageOrContext?: string | LogContext): void {
    this.write('info', input, messageOrContext);
  }

  warn(message: string, context?: LogContext): void;
  warn(context: unknown, message?: string): void;
  warn(input: unknown, messageOrContext?: string | LogContext): void {
    this.write('warn', input, messageOrContext);
  }

  error(message: string, context?: LogContext): void;
  error(context: unknown, message?: string): void;
  error(input: unknown, messageOrContext?: string | LogContext): void {
    this.write('error', input, messageOrContext);
  }

  fatal(message: string, context?: LogContext): void;
  fatal(context: unknown, message?: string): void;
  fatal(input: unknown, messageOrContext?: string | LogContext): void {
    this.write('fatal', input, messageOrContext);
  }

  child(bindings: LogContext): Logger {
    return new CorrelatedLogger(this.logger.child(bindings), this.tracer);
  }

  async flush(): Promise<void> {
    await this.logger.flush?.();
  }

  async close(): Promise<void> {
    await this.logger.close?.();
  }

  private write(
    method: LogMethod,
    input: unknown,
    messageOrContext?: string | LogContext
  ): void {
    const bindings = observationContextLogBindings(this.tracer.getCurrentContext());
    this.call(method, normalizeCorrelatedLogInput(input, messageOrContext, bindings));
  }

  private call(method: LogMethod, input: NormalizedCorrelatedLog): void {
    switch (method) {
      case 'trace':
        return input.kind === CorrelatedLogKind.Message
          ? this.logger.trace(input.message, input.context)
          : this.logger.trace(input.data, input.message);
      case 'debug':
        return input.kind === CorrelatedLogKind.Message
          ? this.logger.debug(input.message, input.context)
          : this.logger.debug(input.data, input.message);
      case 'info':
        return input.kind === CorrelatedLogKind.Message
          ? this.logger.info(input.message, input.context)
          : this.logger.info(input.data, input.message);
      case 'warn':
        return input.kind === CorrelatedLogKind.Message
          ? this.logger.warn(input.message, input.context)
          : this.logger.warn(input.data, input.message);
      case 'error':
        return input.kind === CorrelatedLogKind.Message
          ? this.logger.error(input.message, input.context)
          : this.logger.error(input.data, input.message);
      case 'fatal':
        return input.kind === CorrelatedLogKind.Message
          ? this.logger.fatal(input.message, input.context)
          : this.logger.fatal(input.data, input.message);
    }
  }
}

function normalizeCorrelatedLogInput(
  input: unknown,
  messageOrContext: string | LogContext | undefined,
  bindings: LogContext
): NormalizedCorrelatedLog {
  if (typeof input === 'string') {
    const context =
      typeof messageOrContext === 'object' && messageOrContext !== null
        ? mergeLogContext(bindings, messageOrContext)
        : bindings;

    return {
      kind: CorrelatedLogKind.Message,
      message: input,
      ...(Object.keys(context).length > 0 ? { context } : {}),
    };
  }

  return {
    kind: CorrelatedLogKind.Data,
    data: mergeLogData(bindings, input),
    ...(typeof messageOrContext === 'string' ? { message: messageOrContext } : {}),
  };
}

function mergeLogData(bindings: LogContext, input: unknown): unknown {
  if (Object.keys(bindings).length === 0) return input;
  if (input == null) return bindings;
  if (input instanceof Error) return { ...bindings, error: input };
  if (Array.isArray(input)) return { ...bindings, items: input };
  if (!isRecord(input)) return { ...bindings, value: input };
  return mergeLogContext(bindings, input);
}

function mergeLogContext(bindings: LogContext, context: LogContext): LogContext {
  return { ...bindings, ...context };
}

export function observationContextLogBindings(
  context: ObservationContext | undefined
): LogContext {
  if (context == null) return {};

  return {
    traceId: context.traceId,
    ...(context.spanId != null ? { spanId: context.spanId } : {}),
    ...(context.parentSpanId != null ? { parentSpanId: context.parentSpanId } : {}),
    ...(context.traceParent != null ? { traceparent: context.traceParent } : {}),
    ...(context.traceState != null ? { tracestate: context.traceState } : {}),
    ...(context.traceFlags != null ? { traceFlags: context.traceFlags } : {}),
    ...(context.sampled != null ? { sampled: context.sampled } : {}),
    ...(context.recording != null ? { recording: context.recording } : {}),
  };
}

function isRecord(value: unknown): value is LogContext {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
