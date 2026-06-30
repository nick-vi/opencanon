import { err, ok, type Result } from "./result.ts";

export class JsonParseError extends Error {
  override readonly name = "JsonParseError";
  readonly source: string;

  constructor(message: string, source: string, options?: ErrorOptions) {
    super(message, options);
    this.source = source;
  }
}

export class JsonSerializeError extends Error {
  override readonly name = "JsonSerializeError";
  readonly value: unknown;

  constructor(message: string, value: unknown, options?: ErrorOptions) {
    super(message, options);
    this.value = value;
  }
}

export function parseJson<T = unknown>(source: string): Result<T, JsonParseError> {
  try {
    return ok(JSON.parse(source) as T);
  } catch (error) {
    return err(new JsonParseError(error instanceof Error ? error.message : "Invalid JSON.", source, { cause: error }));
  }
}

export function stringifyJson(value: unknown, space?: number): Result<string, JsonSerializeError> {
  try {
    return ok(JSON.stringify(value, null, space));
  } catch (error) {
    return err(new JsonSerializeError(error instanceof Error ? error.message : "JSON serialization failed.", value, { cause: error }));
  }
}
