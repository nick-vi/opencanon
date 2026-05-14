export type ResourceSignal = "SIGINT" | "SIGTERM" | "beforeExit";

export type ResourceOptions<T> = {
  init(): T | Promise<T>;
  dispose(value: T): void | Promise<void>;
  eager?: boolean;
  signals?: boolean | ResourceSignal[];
};

export type Resource<T> = {
  get(): Promise<T>;
  dispose(): Promise<void>;
  isReady(): boolean;
};

const defaultSignals: ResourceSignal[] = ["SIGINT", "SIGTERM", "beforeExit"];

export function resource<T>(options: ResourceOptions<T>): Resource<T> {
  let value: T | undefined;
  let initialized = false;
  let initPromise: Promise<T> | undefined;
  let disposePromise: Promise<void> | undefined;
  const handlers = new Map<ResourceSignal, () => void>();

  const get = (): Promise<T> => {
    if (initialized) return Promise.resolve(value as T);
    if (disposePromise) return disposePromise.then(() => get());
    if (initPromise) return initPromise;

    try {
      initPromise = Promise.resolve(options.init()).then(
        (resolved) => {
          value = resolved;
          initialized = true;
          initPromise = undefined;
          return resolved;
        },
        (error) => {
          initPromise = undefined;
          throw error;
        },
      );
    } catch (error) {
      initPromise = undefined;
      return Promise.reject(error);
    }

    return initPromise;
  };

  const dispose = (): Promise<void> => {
    if (disposePromise) return disposePromise;
    if (!initialized && !initPromise) return Promise.resolve();

    disposePromise = (async () => {
      try {
        if (initPromise) {
          try {
            await initPromise;
          } catch {
            initPromise = undefined;
            return;
          }
        }

        if (initialized) await options.dispose(value as T);
      } finally {
        value = undefined;
        initialized = false;
        initPromise = undefined;
        disposePromise = undefined;
      }
    })();

    return disposePromise;
  };

  registerSignals(options.signals, handlers, dispose);

  if (options.eager) {
    void get();
  }

  return {
    get,
    dispose,
    isReady: () => initialized,
  };
}

function registerSignals(signals: ResourceOptions<unknown>["signals"], handlers: Map<ResourceSignal, () => void>, dispose: () => Promise<void>) {
  if (signals === undefined || signals === false) return;
  const selected = signals === true ? defaultSignals : signals;
  for (const signal of selected) {
    const handler = () => {
      void dispose();
    };
    handlers.set(signal, handler);
    if (signal === "beforeExit") {
      process.once("beforeExit", handler);
    } else {
      process.once(signal, handler);
    }
  }
}
