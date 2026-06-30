import {
  LOG_LEVEL_NAME_TO_NUMERIC,
  LOG_LEVEL_NUMERIC_TO_NAME,
  LogLevel,
  type LogContext,
  type LogEntry,
  type Logger,
  type LoggerOptions,
  type LoggerTransport,
  type LoggerTransportBucket,
  type LogLevelNumeric,
  prepareLogData,
  type Clock,
} from '@opencanon/observability/ports';
import { parseIsoTimestamp } from '@opencanon/observability/primitives';

export type StructuredLoggerOptions = LoggerOptions & {
  clock: Clock;
  transports?: readonly LoggerTransport[] | undefined;
};

export class StructuredLogger implements Logger {
  private levelLabel: LogLevel;
  private levelNumeric: LogLevelNumeric;
  private baseBindings: LogContext;
  private readonly transportBucket: LoggerTransportBucket;
  private readonly mixin: LoggerOptions['mixin'];
  private readonly redactPaths: readonly string[] | undefined;
  private readonly clock: Clock;

  constructor(options: StructuredLoggerOptions, transportBucket?: LoggerTransportBucket) {
    const { clock, level = LogLevel.INFO, name, bindings = {}, mixin, redactPaths } = options;
    this.clock = clock;
    this.levelLabel = level;
    this.levelNumeric = LOG_LEVEL_NAME_TO_NUMERIC[level];
    this.mixin = mixin;
    this.redactPaths = redactPaths;
    this.transportBucket = transportBucket ?? { list: [...(options.transports ?? [])] };
    this.baseBindings = {
      ...bindings,
      ...(name != null ? { name } : {}),
    };
  }

  get level(): LogLevel {
    return this.levelLabel;
  }

  setLevel(level: LogLevel): void {
    this.levelLabel = level;
    this.levelNumeric = LOG_LEVEL_NAME_TO_NUMERIC[level];
  }

  addTransport(transport: LoggerTransport): () => void {
    this.transportBucket.list.push(transport);
    return () => {
      const index = this.transportBucket.list.indexOf(transport);
      if (index >= 0) this.transportBucket.list.splice(index, 1);
    };
  }

  async flush(): Promise<void> {
    await Promise.all(this.transportBucket.list.map((transport) => transport.flush?.()));
  }

  async close(): Promise<void> {
    await this.flush();
    await Promise.all(this.transportBucket.list.map((transport) => transport.close?.()));
  }

  child(bindings: LogContext): Logger {
    const child = new StructuredLogger(
      {
        clock: this.clock,
        level: this.levelLabel,
        mixin: this.mixin,
        redactPaths: this.redactPaths,
      },
      this.transportBucket
    );
    child.levelNumeric = this.levelNumeric;
    child.baseBindings = { ...this.baseBindings, ...bindings };
    return child;
  }

  trace(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LOG_LEVEL_NAME_TO_NUMERIC.trace, input, messageOrContext);
  }

  debug(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LOG_LEVEL_NAME_TO_NUMERIC.debug, input, messageOrContext);
  }

  info(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LOG_LEVEL_NAME_TO_NUMERIC.info, input, messageOrContext);
  }

  warn(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LOG_LEVEL_NAME_TO_NUMERIC.warn, input, messageOrContext);
  }

  error(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LOG_LEVEL_NAME_TO_NUMERIC.error, input, messageOrContext);
  }

  fatal(input: unknown, messageOrContext?: string | LogContext): void {
    this.write(LOG_LEVEL_NAME_TO_NUMERIC.fatal, input, messageOrContext);
  }

  private write(
    level: LogLevelNumeric,
    input: unknown,
    messageOrContext?: string | LogContext
  ): void {
    if (level < this.levelNumeric) return;

    const normalized = normalizeLogInput(input, messageOrContext, this.redactPaths);
    const entry: LogEntry = {
      ...this.baseBindings,
      ...(this.mixin?.() ?? {}),
      ...normalized.context,
      level,
      levelLabel: LOG_LEVEL_NUMERIC_TO_NAME[level],
      time: loggerTimestamp(this.clock),
      message: normalized.message,
    };

    for (const transport of this.transportBucket.list) {
      transport.write(entry);
    }
  }
}

function normalizeLogInput(
  input: unknown,
  messageOrContext: string | LogContext | undefined,
  redactPaths: readonly string[] | undefined
): { message: string; context: LogContext } {
  if (typeof input === 'string') {
    return {
      message: input,
      context:
        typeof messageOrContext === 'object' && messageOrContext !== null
          ? prepareLogData(messageOrContext, redactPaths)
          : {},
    };
  }

  return {
    message: typeof messageOrContext === 'string' ? messageOrContext : '',
    context: prepareLogData(input, redactPaths),
  };
}

function loggerTimestamp(clock: Clock): string {
  const timestamp = parseIsoTimestamp(clock.now(), 'logger.clock.now');
  if (!timestamp.ok) throw timestamp.error;
  return timestamp.value;
}
