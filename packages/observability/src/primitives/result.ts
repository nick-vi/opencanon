export class UnwrapError extends Error {
  override readonly name = 'UnwrapError';
  override readonly cause: unknown;

  constructor(
    message: string,
    cause: unknown
  ) {
    super(`${message}: ${String(cause)}`, { cause });
    this.cause = cause;
  }
}

export type Result<T, E> = OkResult<T, E> | ErrResult<T, E>;

export type ResultMatch<T, E, R1, R2 = R1> = {
  ok: (value: T) => R1;
  err: (error: E) => R2;
};

interface ResultMethods<T, E> {
  readonly ok: boolean;
  unwrap(): T;
  expect(message: string): T;
  unwrapOr<U>(defaultValue: U): T | U;
  unwrapOrElse<U>(fn: (error: E) => U): T | U;
  match<R1, R2 = R1>(handlers: ResultMatch<T, E, R1, R2>): R1 | R2;
  map<U>(fn: (value: T) => U): Result<U, E>;
  mapErr<F>(fn: (error: E) => F): Result<T, F>;
  flatMap<U, F>(fn: (value: T) => Result<U, F>): Result<U, E | F>;
  asErr<U>(): Result<U, E>;
}

class OkResult<T, E = never> implements ResultMethods<T, E> {
  readonly ok = true as const;
  readonly value: T;

  constructor(value: T) {
    this.value = value;
  }

  unwrap(): T {
    return this.value;
  }

  expect(): T {
    return this.value;
  }

  unwrapOr(): T {
    return this.value;
  }

  unwrapOrElse(): T {
    return this.value;
  }

  match<R1, R2 = R1>(handlers: ResultMatch<T, E, R1, R2>): R1 | R2 {
    return handlers.ok(this.value);
  }

  map<U>(fn: (value: T) => U): Result<U, E> {
    return new OkResult(fn(this.value));
  }

  mapErr<F>(): Result<T, F> {
    return this as unknown as OkResult<T, F>;
  }

  flatMap<U, F>(fn: (value: T) => Result<U, F>): Result<U, E | F> {
    return fn(this.value);
  }

  asErr<U>(): Result<U, E> {
    return this as unknown as OkResult<U, E>;
  }
}

class ErrResult<T = never, E = unknown> implements ResultMethods<T, E> {
  readonly ok = false as const;
  readonly error: E;

  constructor(error: E) {
    this.error = error;
  }

  unwrap(): T {
    throw new UnwrapError('Unwrap called on Err', this.error);
  }

  expect(message: string): T {
    throw new UnwrapError(message, this.error);
  }

  unwrapOr<U>(defaultValue: U): U {
    return defaultValue;
  }

  unwrapOrElse<U>(fn: (error: E) => U): U {
    return fn(this.error);
  }

  match<R1, R2 = R1>(handlers: ResultMatch<T, E, R1, R2>): R1 | R2 {
    return handlers.err(this.error);
  }

  map<U>(): Result<U, E> {
    return this as unknown as ErrResult<U, E>;
  }

  mapErr<F>(fn: (error: E) => F): Result<T, F> {
    return new ErrResult(fn(this.error));
  }

  flatMap<U, F>(): Result<U, E | F> {
    return this as unknown as ErrResult<U, E>;
  }

  asErr<U>(): Result<U, E> {
    return this as unknown as ErrResult<U, E>;
  }
}

export const Ok = <T>(value: T): Result<T, never> => new OkResult(value);
export const Err = <E>(error: E): Result<never, E> => new ErrResult(error);

export function isOk<T, E>(result: Result<T, E>): result is OkResult<T, E>;
export function isOk<T extends { ok: boolean }>(result: T): result is T & { ok: true };
export function isOk(result: { ok: boolean }): boolean {
  return result.ok;
}

export function isErr<T, E>(result: Result<T, E>): result is ErrResult<T, E>;
export function isErr<T extends { ok: boolean }>(result: T): result is T & { ok: false };
export function isErr(result: { ok: boolean }): boolean {
  return !result.ok;
}

export const Result = {
  try<T, E>(fn: () => T): Result<T, E> {
    try {
      return Ok(fn());
    } catch (error) {
      if (error instanceof UnwrapError) {
        return Err(error.cause as E);
      }
      throw error;
    }
  },

  async tryAsync<T, E>(fn: () => Promise<T>): Promise<Result<T, E>> {
    try {
      return Ok(await fn());
    } catch (error) {
      if (error instanceof UnwrapError) {
        return Err(error.cause as E);
      }
      throw error;
    }
  },

  all<T extends readonly Result<unknown, unknown>[]>(
    results: T
  ): Result<
    { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never },
    T[number] extends Result<unknown, infer E> ? E : never
  > {
    type Values = { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never };
    type Errors = T[number] extends Result<unknown, infer E> ? E : never;

    const values: unknown[] = [];
    for (const result of results) {
      if (isErr(result)) {
        return Err(result.error) as Result<Values, Errors>;
      }
      values.push(result.value);
    }
    return Ok(values) as Result<Values, Errors>;
  },

  collect<T extends readonly Result<unknown, unknown>[]>(
    results: T
  ): Result<
    { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never },
    Array<T[number] extends Result<unknown, infer E> ? E : never>
  > {
    const values: unknown[] = [];
    const errors: unknown[] = [];

    for (const result of results) {
      if (isErr(result)) {
        errors.push(result.error);
      } else {
        values.push(result.value);
      }
    }

    if (errors.length > 0) {
      return Err(errors) as Result<
        { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never },
        Array<T[number] extends Result<unknown, infer E> ? E : never>
      >;
    }

    return Ok(values) as Result<
      { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never },
      Array<T[number] extends Result<unknown, infer E> ? E : never>
    >;
  },

  allObject<T extends Record<string, Result<unknown, unknown>>>(
    results: T
  ): Result<
    { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never },
    T[keyof T] extends Result<unknown, infer E> ? E : never
  > {
    type Values = { [K in keyof T]: T[K] extends Result<infer U, unknown> ? U : never };
    type Errors = T[keyof T] extends Result<unknown, infer E> ? E : never;

    const values: Record<string, unknown> = {};
    for (const [key, result] of Object.entries(results)) {
      if (isErr(result)) {
        return Err(result.error) as Result<Values, Errors>;
      }
      values[key] = result.value;
    }
    return Ok(values) as Result<Values, Errors>;
  },
};

export class ResultAsync<T, E> implements PromiseLike<Result<T, E>> {
  private readonly promise: Promise<Result<T, E>>;

  private constructor(promise: Promise<Result<T, E>>) {
    this.promise = promise;
  }

  static fromPromise<T, E>(
    promise: Promise<T>,
    errorMapper: (error: unknown) => E = (error) => error as E
  ): ResultAsync<T, E> {
    return new ResultAsync(
      promise.then(
        (value) => Ok(value) as Result<T, E>,
        (error) => Err(errorMapper(error)) as Result<T, E>
      )
    );
  }

  static from<T, E>(fn: () => Promise<Result<T, E>>): ResultAsync<T, E> {
    return new ResultAsync(fn());
  }

  static ok<T, E = never>(value: T): ResultAsync<T, E> {
    return new ResultAsync(Promise.resolve(Ok(value) as Result<T, E>));
  }

  static err<T = never, E = unknown>(error: E): ResultAsync<T, E> {
    return new ResultAsync(Promise.resolve(Err(error) as Result<T, E>));
  }

  map<U>(fn: (value: T) => U | Promise<U>): ResultAsync<U, E> {
    return new ResultAsync(
      this.promise.then(async (result) => {
        if (isErr(result)) return result.asErr<U>();
        return Ok(await fn(result.value)) as Result<U, E>;
      })
    );
  }

  mapErr<F>(fn: (error: E) => F | Promise<F>): ResultAsync<T, F> {
    return new ResultAsync(
      this.promise.then(async (result) => {
        if (isOk(result)) return result as unknown as Result<T, F>;
        return Err(await fn(result.error)) as Result<T, F>;
      })
    );
  }

  flatMap<U, F>(
    fn: (value: T) => ResultAsync<U, F> | Promise<Result<U, F>>
  ): ResultAsync<U, E | F> {
    return new ResultAsync(
      this.promise.then(async (result) => {
        if (isErr(result)) return result.asErr<U>();
        const next = fn(result.value);
        if (next instanceof ResultAsync) return next.promise;
        return next;
      })
    );
  }

  tap(fn: (value: T) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.promise.then(async (result) => {
        if (isOk(result)) await fn(result.value);
        return result;
      })
    );
  }

  tapErr(fn: (error: E) => void | Promise<void>): ResultAsync<T, E> {
    return new ResultAsync(
      this.promise.then(async (result) => {
        if (isErr(result)) await fn(result.error);
        return result;
      })
    );
  }

  async match<R1, R2 = R1>(
    handlers: ResultMatch<T, E, R1 | Promise<R1>, R2 | Promise<R2>>
  ): Promise<R1 | R2> {
    const result = await this.promise;
    if (isOk(result)) return handlers.ok(result.value);
    return handlers.err(result.error);
  }

  async unwrapOr<U>(defaultValue: U): Promise<T | U> {
    const result = await this.promise;
    return result.unwrapOr(defaultValue);
  }

  async unwrapOrElse<U>(fn: (error: E) => U | Promise<U>): Promise<T | U> {
    const result = await this.promise;
    if (isOk(result)) return result.value;
    return fn(result.error);
  }

  then<TResult1 = Result<T, E>, TResult2 = never>(
    onfulfilled?: ((value: Result<T, E>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null
  ): PromiseLike<TResult1 | TResult2> {
    return this.promise.then(onfulfilled, onrejected);
  }
}
