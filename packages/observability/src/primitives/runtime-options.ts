export class RuntimeOptionError extends RangeError {
  override readonly name = 'RuntimeOptionError';
  readonly option: string;
  readonly value: unknown;
  readonly expected: string;

  constructor(
    option: string,
    value: unknown,
    expected: string
  ) {
    super(`${option} must be ${expected}; received ${formatRuntimeOptionValue(value)}`);
    this.option = option;
    this.value = value;
    this.expected = expected;
  }
}

export type PaginationOptions = {
  limit?: number | undefined;
  offset?: number | undefined;
};

export type ResolvedPaginationOptions = {
  limit: number;
  offset: number;
};

export function positiveIntegerOption(option: string, value: unknown): number {
  if (isSafeInteger(value) && value > 0) return value;
  throw new RuntimeOptionError(option, value, 'a positive safe integer');
}

export function nonNegativeIntegerOption(option: string, value: unknown): number {
  if (isSafeInteger(value) && value >= 0) return value;
  throw new RuntimeOptionError(option, value, 'a non-negative safe integer');
}

export function optionalPositiveIntegerOption(
  option: string,
  value: unknown
): number | undefined {
  if (value === undefined) return undefined;
  return positiveIntegerOption(option, value);
}

export function optionalNonNegativeIntegerOption(
  option: string,
  value: unknown
): number | undefined {
  if (value === undefined) return undefined;
  return nonNegativeIntegerOption(option, value);
}

export function normalizePaginationOptions(
  options: PaginationOptions,
  total: number
): ResolvedPaginationOptions {
  return {
    limit: optionalPositiveIntegerOption('limit', options.limit) ?? total,
    offset: optionalNonNegativeIntegerOption('offset', options.offset) ?? 0,
  };
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value);
}

function formatRuntimeOptionValue(value: unknown): string {
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return String(value);
  }
  return Object.prototype.toString.call(value);
}
