export type LazyValue<T> = {
  (): T;
  isReady(): boolean;
  reset(): void;
};

export function lazy<T>(factory: () => Promise<T>): LazyValue<Promise<T>>;
export function lazy<T>(factory: () => T): LazyValue<T>;
export function lazy<T>(factory: () => T | Promise<T>): LazyValue<T | Promise<T>> {
  let value: T | undefined;
  let promise: Promise<T> | undefined;
  let ready = false;
  let generation = 0;

  const read = (): T | Promise<T> => {
    if (ready) return value as T;
    if (promise) return promise;

    const result = factory();
    if (isPromiseLike(result)) {
      const promiseGeneration = generation;
      promise = result.then(
        (resolved) => {
          if (promiseGeneration === generation) {
            value = resolved;
            ready = true;
            promise = undefined;
          }
          return resolved;
        },
        (error) => {
          if (promiseGeneration === generation) promise = undefined;
          throw error;
        },
      );
      return promise;
    }

    value = result;
    ready = true;
    return result;
  };

  read.isReady = () => ready;
  read.reset = () => {
    generation += 1;
    value = undefined;
    promise = undefined;
    ready = false;
  };

  return read;
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object" && value !== null && "then" in value && typeof value.then === "function";
}
