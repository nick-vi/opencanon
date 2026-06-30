import { Err, Ok, type Result } from './result.ts';

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

const CANONICAL_UTC_TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

export class TimestampError extends Error {
  override readonly name = 'TimestampError';
  readonly code: 'invalid_iso_timestamp' | 'invalid_duration' | 'timestamp_out_of_range';
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    code: 'invalid_iso_timestamp' | 'invalid_duration' | 'timestamp_out_of_range',
    message: string,
    details?: Record<string, unknown> | undefined
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export function parseIsoTimestamp(
  value: string,
  fieldName = 'value'
): Result<string, TimestampError> {
  if (!CANONICAL_UTC_TIMESTAMP_PATTERN.test(value)) {
    return Err(
      new TimestampError(
        'invalid_iso_timestamp',
        `${fieldName} must be a canonical UTC ISO timestamp`,
        { fieldName, value }
      )
    );
  }

  const epochMs = Date.parse(value);
  if (!Number.isFinite(epochMs)) {
    return Err(
      new TimestampError(
        'invalid_iso_timestamp',
        `${fieldName} must be a valid ISO timestamp`,
        { fieldName, value }
      )
    );
  }

  if (new Date(epochMs).toISOString() !== value) {
    return Err(
      new TimestampError(
        'invalid_iso_timestamp',
        `${fieldName} must be a normalized UTC ISO timestamp`,
        { fieldName, value }
      )
    );
  }

  return Ok(value);
}

export function isIsoTimestamp(value: string): boolean {
  return parseIsoTimestamp(value).ok;
}

export function isoTimestampEpochMs(
  value: string,
  fieldName = 'value'
): Result<number, TimestampError> {
  const parsed = parseIsoTimestamp(value, fieldName);
  if (!parsed.ok) return parsed.asErr<number>();
  return Ok(Date.parse(parsed.value));
}

export function compareIsoTimestamps(
  left: string,
  right: string
): Result<number, TimestampError> {
  const leftMs = isoTimestampEpochMs(left, 'left');
  if (!leftMs.ok) return leftMs.asErr<number>();

  const rightMs = isoTimestampEpochMs(right, 'right');
  if (!rightMs.ok) return rightMs.asErr<number>();

  if (leftMs.value < rightMs.value) return Ok(-1);
  if (leftMs.value > rightMs.value) return Ok(1);
  return Ok(0);
}

export function isIsoTimestampAtOrBefore(
  left: string,
  right: string
): Result<boolean, TimestampError> {
  return compareIsoTimestamps(left, right).map((comparison) => comparison <= 0);
}

export function addMillisecondsToIsoTimestamp(
  timestamp: string,
  milliseconds: number
): Result<string, TimestampError> {
  if (!Number.isInteger(milliseconds)) {
    return Err(
      new TimestampError('invalid_duration', 'milliseconds must be an integer', {
        milliseconds,
      })
    );
  }

  const epochMs = isoTimestampEpochMs(timestamp, 'timestamp');
  if (!epochMs.ok) return epochMs.asErr<string>();

  const next = epochMs.value + milliseconds;
  if (!Number.isSafeInteger(next)) {
    return Err(
      new TimestampError('timestamp_out_of_range', 'timestamp arithmetic is out of range', {
        timestamp,
        milliseconds,
      })
    );
  }

  try {
    const value = new Date(next).toISOString();
    const parsed = parseIsoTimestamp(value, 'timestamp');
    if (parsed.ok) return Ok(value);

    return Err(
      new TimestampError('timestamp_out_of_range', 'timestamp arithmetic is out of range', {
        timestamp,
        milliseconds,
        value,
      })
    );
  } catch (error) {
    return Err(
      new TimestampError('timestamp_out_of_range', 'timestamp arithmetic is out of range', {
        timestamp,
        milliseconds,
        cause: error instanceof Error ? error.message : String(error),
      })
    );
  }
}

export function millisecondsBetweenIsoTimestamps(
  start: string,
  end: string
): Result<number, TimestampError> {
  const startMs = isoTimestampEpochMs(start, 'start');
  if (!startMs.ok) return startMs.asErr<number>();

  const endMs = isoTimestampEpochMs(end, 'end');
  if (!endMs.ok) return endMs.asErr<number>();

  return Ok(endMs.value - startMs.value);
}
