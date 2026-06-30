import { Err, Ok, type Result } from './result.ts';

export const BAGGAGE_HEADER = 'baggage';
export const BAGGAGE_MAX_ENTRIES = 64;
export const BAGGAGE_MAX_BYTES = 8192;

export type BaggageProperty = {
  key: string;
  value?: string | undefined;
};

export type BaggageEntry = {
  key: string;
  value: string;
  properties: BaggageProperty[];
};

export type Baggage = {
  entries: BaggageEntry[];
};

export const BaggageErrorKind = Object.freeze({
  InvalidKey: 'invalid_key',
  InvalidProperty: 'invalid_property',
  InvalidValue: 'invalid_value',
  TooManyEntries: 'too_many_entries',
  TooLarge: 'too_large',
} as const);

export type BaggageErrorKind = (typeof BaggageErrorKind)[keyof typeof BaggageErrorKind];

export class BaggageError extends Error {
  override readonly name = 'BaggageError';
  readonly kind: BaggageErrorKind;
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    kind: BaggageErrorKind,
    message: string,
    details?: Record<string, unknown> | undefined
  ) {
    super(message);
    this.kind = kind;
    this.details = details;
  }
}

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

export function parseBaggage(input: string | readonly string[]): Result<Baggage, BaggageError> {
  const header = typeof input === 'string' ? input : input.join(',');
  if (header.trim().length === 0) return Ok({ entries: [] });

  const members = header.split(',');
  if (members.length > BAGGAGE_MAX_ENTRIES) {
    return Err(
      new BaggageError(BaggageErrorKind.TooManyEntries, 'Baggage contains too many entries', {
        count: members.length,
        max: BAGGAGE_MAX_ENTRIES,
      })
    );
  }

  const entries: BaggageEntry[] = [];
  for (const member of members) {
    const parsed = parseBaggageEntry(member);
    if (!parsed.ok) return parsed.asErr<Baggage>();
    entries.push(parsed.value);
  }

  const baggage: Baggage = { entries };
  const formatted = formatBaggage(baggage);
  if (!formatted.ok) return formatted.asErr<Baggage>();
  return Ok(baggage);
}

export function formatBaggage(baggage: Baggage): Result<string, BaggageError> {
  if (baggage.entries.length > BAGGAGE_MAX_ENTRIES) {
    return Err(
      new BaggageError(BaggageErrorKind.TooManyEntries, 'Baggage contains too many entries', {
        count: baggage.entries.length,
        max: BAGGAGE_MAX_ENTRIES,
      })
    );
  }

  const members: string[] = [];
  for (const entry of baggage.entries) {
    const formatted = formatBaggageEntry(entry);
    if (!formatted.ok) return formatted.asErr<string>();
    members.push(formatted.value);
  }

  const header = members.join(',');
  const bytes = new TextEncoder().encode(header).length;
  if (bytes > BAGGAGE_MAX_BYTES) {
    return Err(
      new BaggageError(BaggageErrorKind.TooLarge, 'Baggage header is too large', {
        bytes,
        max: BAGGAGE_MAX_BYTES,
      })
    );
  }

  return Ok(header);
}

export function setBaggageEntry(
  baggage: Baggage,
  input: { key: string; value: string; properties?: BaggageProperty[] | undefined }
): Result<Baggage, BaggageError> {
  const entry: BaggageEntry = {
    key: input.key,
    value: input.value,
    properties: input.properties ?? [],
  };
  const formatted = formatBaggageEntry(entry);
  if (!formatted.ok) return formatted.asErr<Baggage>();

  const entries = baggage.entries.filter((candidate) => candidate.key !== input.key);
  return formatBaggage({ entries: [...entries, entry] }).map(() => ({ entries: [...entries, entry] }));
}

export function removeBaggageEntry(baggage: Baggage, key: string): Baggage {
  return {
    entries: baggage.entries.filter((entry) => entry.key !== key),
  };
}

export function baggageToRecord(baggage: Baggage): Record<string, string> {
  const record: Record<string, string> = {};
  for (const entry of baggage.entries) {
    if (!(entry.key in record)) record[entry.key] = entry.value;
  }
  return record;
}

function parseBaggageEntry(input: string): Result<BaggageEntry, BaggageError> {
  const [keyValue = '', ...propertyParts] = input.split(';');
  const separatorIndex = keyValue.indexOf('=');
  if (separatorIndex < 0) {
    return Err(
      new BaggageError(BaggageErrorKind.InvalidKey, 'Baggage entry must contain a key and value')
    );
  }

  const key = keyValue.slice(0, separatorIndex).trim();
  const encodedValue = keyValue.slice(separatorIndex + 1).trim();
  if (!isToken(key)) {
    return Err(new BaggageError(BaggageErrorKind.InvalidKey, 'Baggage key is invalid', { key }));
  }
  if (!VALUE.test(encodedValue)) {
    return Err(
      new BaggageError(BaggageErrorKind.InvalidValue, 'Baggage value contains invalid characters', {
        key,
      })
    );
  }

  const decoded = decodeBaggageValue(encodedValue);
  if (!decoded.ok) return decoded.asErr<BaggageEntry>();

  const properties: BaggageProperty[] = [];
  for (const part of propertyParts) {
    const parsed = parseBaggageProperty(part);
    if (!parsed.ok) return parsed.asErr<BaggageEntry>();
    properties.push(parsed.value);
  }

  return Ok({
    key,
    value: decoded.value,
    properties,
  });
}

function parseBaggageProperty(input: string): Result<BaggageProperty, BaggageError> {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return Err(new BaggageError(BaggageErrorKind.InvalidProperty, 'Baggage property is empty'));
  }

  const separatorIndex = trimmed.indexOf('=');
  const key = separatorIndex < 0 ? trimmed : trimmed.slice(0, separatorIndex).trim();
  const value = separatorIndex < 0 ? undefined : trimmed.slice(separatorIndex + 1).trim();
  if (!isToken(key)) {
    return Err(
      new BaggageError(BaggageErrorKind.InvalidProperty, 'Baggage property key is invalid', {
        key,
      })
    );
  }
  if (value != null && !VALUE.test(value)) {
    return Err(
      new BaggageError(BaggageErrorKind.InvalidProperty, 'Baggage property value is invalid', {
        key,
      })
    );
  }

  return Ok({
    key,
    ...(value != null ? { value } : {}),
  });
}

function formatBaggageEntry(entry: BaggageEntry): Result<string, BaggageError> {
  if (!isToken(entry.key)) {
    return Err(
      new BaggageError(BaggageErrorKind.InvalidKey, 'Baggage key is invalid', {
        key: entry.key,
      })
    );
  }

  const encodedValue = encodeBaggageValue(entry.value);
  const properties: string[] = [];
  for (const property of entry.properties) {
    if (!isToken(property.key)) {
      return Err(
        new BaggageError(BaggageErrorKind.InvalidProperty, 'Baggage property key is invalid', {
          key: property.key,
        })
      );
    }
    properties.push(
      property.value == null ? property.key : `${property.key}=${encodeBaggageValue(property.value)}`
    );
  }

  return Ok(`${entry.key}=${encodedValue}${properties.map((property) => `;${property}`).join('')}`);
}

function isToken(value: string): boolean {
  return TOKEN.test(value);
}

function encodeBaggageValue(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function decodeBaggageValue(value: string): Result<string, BaggageError> {
  try {
    return Ok(decodeURIComponent(value));
  } catch (error) {
    return Err(
      new BaggageError(BaggageErrorKind.InvalidValue, 'Baggage value is not valid percent encoding', {
        value,
        cause: error,
      })
    );
  }
}
