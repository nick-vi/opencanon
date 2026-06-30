import {
  createOpenCanonDiagnosticsError,
  createOpenCanonProblemError,
  type OpenCanonDiagnostic,
  type OpenCanonErrorPayload,
} from "./errors.ts";
import type { OpenCanonProblem } from "./problem.ts";

export type OkResult<T> = {
  ok: true;
  data: T;
};

export type ErrResult<E = OpenCanonErrorPayload> = {
  ok: false;
  error: E;
};

export type Result<T, E = OpenCanonErrorPayload> = OkResult<T> | ErrResult<E>;

export type ResultMatch<T, E, OkValue, ErrValue = OkValue> = {
  ok: (data: T) => OkValue;
  err: (error: E) => ErrValue;
};

export function ok<T>(data: T): OkResult<T> {
  return { ok: true, data };
}

export function err<E = OpenCanonErrorPayload>(error: E): ErrResult<E> {
  return { ok: false, error };
}

export function errFromDiagnostics(diagnostics: OpenCanonDiagnostic[]): ErrResult<OpenCanonErrorPayload> {
  return err(createOpenCanonDiagnosticsError(diagnostics));
}

export function errFromProblem(problem: OpenCanonProblem): ErrResult<OpenCanonErrorPayload> {
  return err(createOpenCanonProblemError(problem));
}

export function isOk<T, E>(result: Result<T, E>): result is OkResult<T>;
export function isOk<T extends { ok: boolean }>(result: T): result is T & { ok: true };
export function isOk(result: { ok: boolean }): boolean {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is ErrResult<E>;
export function isErr<T extends { ok: boolean }>(result: T): result is T & { ok: false };
export function isErr(result: { ok: boolean }): boolean {
  return !result.ok;
}

export function mapResult<T, E, Next>(result: Result<T, E>, map: (data: T) => Next): Result<Next, E> {
  if (result.ok) return ok(map(result.data));
  return result;
}

export function mapResultError<T, E, Next>(result: Result<T, E>, map: (error: E) => Next): Result<T, Next> {
  if (result.ok) return result;
  return err(map(result.error));
}

export function flatMapResult<T, E, Next, NextError>(
  result: Result<T, E>,
  map: (data: T) => Result<Next, NextError>,
): Result<Next, E | NextError> {
  if (result.ok) return map(result.data);
  return result;
}

export function matchResult<T, E, OkValue, ErrValue = OkValue>(
  result: Result<T, E>,
  handlers: ResultMatch<T, E, OkValue, ErrValue>,
): OkValue | ErrValue {
  return result.ok ? handlers.ok(result.data) : handlers.err(result.error);
}

export function unwrapResultOr<T, E, Fallback>(result: Result<T, E>, fallback: Fallback | ((error: E) => Fallback)): T | Fallback {
  if (result.ok) return result.data;
  return typeof fallback === "function" ? (fallback as (error: E) => Fallback)(result.error) : fallback;
}

export function resultAll<T extends readonly Result<unknown, unknown>[]>(
  results: T,
): Result<
  { [K in keyof T]: T[K] extends Result<infer Value, unknown> ? Value : never },
  T[number] extends Result<unknown, infer Error> ? Error : never
> {
  type Values = { [K in keyof T]: T[K] extends Result<infer Value, unknown> ? Value : never };
  type Errors = T[number] extends Result<unknown, infer Error> ? Error : never;
  const values: unknown[] = [];

  for (const result of results) {
    if (!result.ok) return err(result.error as Errors);
    values.push(result.data);
  }

  return ok(values as Values);
}

export function resultCollect<T extends readonly Result<unknown, unknown>[]>(
  results: T,
): Result<
  { [K in keyof T]: T[K] extends Result<infer Value, unknown> ? Value : never },
  Array<T[number] extends Result<unknown, infer Error> ? Error : never>
> {
  type Values = { [K in keyof T]: T[K] extends Result<infer Value, unknown> ? Value : never };
  type Errors = T[number] extends Result<unknown, infer Error> ? Error : never;
  const values: unknown[] = [];
  const errors: Errors[] = [];

  for (const result of results) {
    if (result.ok) values.push(result.data);
    else errors.push(result.error as Errors);
  }

  if (errors.length > 0) return err(errors);
  return ok(values as Values);
}

export function tryResult<T, E>(run: () => T, mapError: (error: unknown) => E): Result<T, E> {
  try {
    return ok(run());
  } catch (error) {
    return err(mapError(error));
  }
}

export async function tryResultAsync<T, E>(run: () => Promise<T>, mapError: (error: unknown) => E): Promise<Result<T, E>> {
  try {
    return ok(await run());
  } catch (error) {
    return err(mapError(error));
  }
}
