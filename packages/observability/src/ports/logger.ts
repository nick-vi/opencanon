export type LogContext = Record<string, unknown>;

export const LogLevel = Object.freeze({
  TRACE: 'trace',
  DEBUG: 'debug',
  INFO: 'info',
  WARN: 'warn',
  ERROR: 'error',
  FATAL: 'fatal',
} as const);

export type LogLevel = (typeof LogLevel)[keyof typeof LogLevel];

export const LogLevelNumeric = Object.freeze({
  TRACE: 10,
  DEBUG: 20,
  INFO: 30,
  WARN: 40,
  ERROR: 50,
  FATAL: 60,
} as const);

export type LogLevelNumeric = (typeof LogLevelNumeric)[keyof typeof LogLevelNumeric];

export const LOG_LEVEL_NUMERIC_TO_NAME: Record<LogLevelNumeric, LogLevel> = Object.freeze({
  [LogLevelNumeric.TRACE]: LogLevel.TRACE,
  [LogLevelNumeric.DEBUG]: LogLevel.DEBUG,
  [LogLevelNumeric.INFO]: LogLevel.INFO,
  [LogLevelNumeric.WARN]: LogLevel.WARN,
  [LogLevelNumeric.ERROR]: LogLevel.ERROR,
  [LogLevelNumeric.FATAL]: LogLevel.FATAL,
});

export const LOG_LEVEL_NAME_TO_NUMERIC: Record<LogLevel, LogLevelNumeric> = Object.freeze({
  [LogLevel.TRACE]: LogLevelNumeric.TRACE,
  [LogLevel.DEBUG]: LogLevelNumeric.DEBUG,
  [LogLevel.INFO]: LogLevelNumeric.INFO,
  [LogLevel.WARN]: LogLevelNumeric.WARN,
  [LogLevel.ERROR]: LogLevelNumeric.ERROR,
  [LogLevel.FATAL]: LogLevelNumeric.FATAL,
});

export type SerializedLogError = {
  message: string;
  name: string;
  stack?: string;
  cause?: SerializedLogError;
  [key: string]: unknown;
};

export type LogEntry = LogContext & {
  level: LogLevelNumeric;
  levelLabel: LogLevel;
  time: string;
  message: string;
};

export type LogMixin = () => LogContext;

export type LoggerOptions = {
  level?: LogLevel | undefined;
  name?: string | undefined;
  bindings?: LogContext | undefined;
  mixin?: LogMixin | undefined;
  redactPaths?: readonly string[] | undefined;
};

export type LoggerTransport = {
  write(entry: LogEntry): void;
  flush?(): Promise<void>;
  close?(): Promise<void>;
};

export type LoggerTransportBucket = {
  readonly list: LoggerTransport[];
};

export interface Logger {
  trace(message: string, context?: LogContext): void;
  trace(context: unknown, message?: string): void;
  debug(message: string, context?: LogContext): void;
  debug(context: unknown, message?: string): void;
  info(message: string, context?: LogContext): void;
  info(context: unknown, message?: string): void;
  warn(message: string, context?: LogContext): void;
  warn(context: unknown, message?: string): void;
  error(message: string, context?: LogContext): void;
  error(context: unknown, message?: string): void;
  fatal(message: string, context?: LogContext): void;
  fatal(context: unknown, message?: string): void;
  child(bindings: LogContext): Logger;
  flush?(): Promise<void>;
  close?(): Promise<void>;
}

const DEFAULT_REDACT_PATHS = ['password', 'token', 'apiKey', 'secret', 'authorization'] as const;
const REDACTED_VALUE = '[REDACTED]';
const MAX_ERROR_CAUSE_DEPTH = 10;

export function serializeLogError(error: unknown, depth = 0): SerializedLogError {
  if (error instanceof Error) {
    const serialized: SerializedLogError = {
      message: error.message,
      name: error.name,
      ...(error.stack != null ? { stack: error.stack } : {}),
    };

    if ('cause' in error && error.cause !== undefined && depth < MAX_ERROR_CAUSE_DEPTH) {
      serialized.cause = serializeLogError(error.cause, depth + 1);
    }

    for (const key of Object.keys(error)) {
      const value = (error as unknown as LogContext)[key];
      if (value !== undefined && typeof value !== 'function' && !(key in serialized)) {
        serialized[key] = value;
      }
    }

    return serialized;
  }

  if (isPlainObject(error)) {
    return {
      message: String(error.message ?? 'Unknown error'),
      name: String(error.name ?? 'Error'),
      ...error,
    };
  }

  return {
    message: String(error),
    name: 'Error',
  };
}

export function prepareLogData(
  data: unknown,
  redactPaths: readonly string[] = DEFAULT_REDACT_PATHS
): LogContext {
  const state = createRedactionState(redactPaths);
  if (data == null) return {};
  if (data instanceof Error) return { error: serializeLogError(data) };
  if (Array.isArray(data)) return { items: redactLogValue(data, undefined, state) };
  if (!isPlainObject(data)) return { value: data };

  state.seen.add(data);
  const prepared: LogContext = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || typeof value === 'function') continue;
    prepared[key] = redactLogValue(value, key, state);
  }

  return prepared;
}

export function redactLogData(
  data: LogContext,
  redactPaths: readonly string[] = DEFAULT_REDACT_PATHS
): LogContext {
  return redactLogValue(data, undefined, createRedactionState(redactPaths)) as LogContext;
}

export function safeStringifyLogValue(value: unknown): string {
  const seen = new WeakSet<object>();

  try {
    return JSON.stringify(value, (_key, item) => {
      if (typeof item === 'bigint') return item.toString();
      if (typeof item === 'function') return undefined;
      if (item === undefined) return null;
      if (typeof item === 'object' && item !== null) {
        if (seen.has(item)) return '[Circular]';
        seen.add(item);
      }
      return item;
    });
  } catch {
    return JSON.stringify({ error: 'Failed to serialize log value' });
  }
}

function redactLogValue(
  value: unknown,
  key: string | undefined,
  state: RedactionState
): unknown {
  if (key != null && state.redactedKeys.has(key.toLowerCase())) return REDACTED_VALUE;
  if (value instanceof Error) return serializeLogError(value);

  if (Array.isArray(value)) {
    if (state.seen.has(value)) return '[Circular]';
    state.seen.add(value);
    return value.map((item) => redactLogValue(item, undefined, state));
  }

  if (!isPlainObject(value)) return value;
  if (state.seen.has(value)) return '[Circular]';
  state.seen.add(value);

  const output: LogContext = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    if (childValue === undefined || typeof childValue === 'function') continue;
    output[childKey] =
      childValue instanceof Error
        ? serializeLogError(childValue)
        : redactLogValue(childValue, childKey, state);
  }
  return output;
}

type RedactionState = {
  redactedKeys: Set<string>;
  seen: WeakSet<object>;
};

function createRedactionState(redactPaths: readonly string[]): RedactionState {
  return {
    redactedKeys: new Set(redactPaths.map((path) => path.toLowerCase())),
    seen: new WeakSet<object>(),
  };
}

function isPlainObject(value: unknown): value is LogContext {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
