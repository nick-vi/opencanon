import { AsyncLocalStorage } from 'node:async_hooks';
import { deepFreeze } from './deep-freeze.ts';

declare const NoInitialBrand: unique symbol;
type NoInitial = { readonly [NoInitialBrand]: true };

export class ContextNotFoundError extends Error {
  override readonly name = 'ContextNotFoundError';
  readonly contextName?: string | undefined;

  constructor(contextName?: string | undefined) {
    super(`No context found${contextName != null ? ` for ${contextName}` : ''}`);
    this.contextName = contextName;
  }
}

export class ContextMutationError extends Error {
  override readonly name = 'ContextMutationError';
  readonly field: string;
  readonly contextName?: string | undefined;

  constructor(
    field: string,
    contextName?: string | undefined
  ) {
    super(`Cannot mutate readonly field "${field}"${contextName != null ? ` in ${contextName}` : ''}`);
    this.field = field;
    this.contextName = contextName;
  }
}

export type ProvideValue<T, I> = [I] extends [NoInitial]
  ? T
  : Omit<T, keyof I & keyof T> & Partial<Pick<T, keyof I & keyof T>>;

export type ContextManager<T, I = NoInitial> = {
  use(): T;
  tryUse(): T | undefined;
  provide<R>(value: ProvideValue<T, I>, fn: () => R): R;
  mutate(mutator: (value: T) => void): void;
};

export function createContext<T, const I extends Partial<T> = Partial<T>>(options: {
  name?: string | undefined;
  initial: NoInfer<I>;
}): ContextManager<T, I>;
export function createContext<T>(options?: { name?: string | undefined }): ContextManager<T>;
export function createContext<T, I extends Partial<T>>(options?: {
  name?: string | undefined;
  initial?: I | undefined;
}): ContextManager<T, I | NoInitial> {
  const storage = new AsyncLocalStorage<T>();
  const contextName = options?.name;
  const initialValue = options?.initial;

  return {
    provide<R>(value: ProvideValue<T, I | NoInitial>, fn: () => R): R {
      const merged = initialValue == null ? (value as T) : ({ ...initialValue, ...value } as T);
      if (hasMetadata(merged)) deepFreeze(merged.metadata);
      return storage.run(merged, fn);
    },

    use(): T {
      const value = storage.getStore();
      if (value === undefined) throw new ContextNotFoundError(contextName);
      return value;
    },

    tryUse(): T | undefined {
      return storage.getStore();
    },

    mutate(mutator: (value: T) => void): void {
      const value = storage.getStore();
      if (value !== undefined) mutator(protectContextValue(value, contextName));
    },
  };
}

function hasMetadata(value: unknown): value is { metadata: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'metadata' in value &&
    typeof value.metadata === 'object' &&
    value.metadata !== null
  );
}

function protectContextValue<T>(value: T, contextName?: string | undefined): T {
  if (!hasMetadata(value)) return value;

  return new Proxy(value as object, {
    set(target, property, propertyValue, receiver) {
      if (property === 'metadata') throw new ContextMutationError('metadata', contextName);
      return Reflect.set(target, property, propertyValue, receiver);
    },
    defineProperty(target, property, attributes) {
      if (property === 'metadata') throw new ContextMutationError('metadata', contextName);
      return Reflect.defineProperty(target, property, attributes);
    },
    deleteProperty(target, property) {
      if (property === 'metadata') throw new ContextMutationError('metadata', contextName);
      return Reflect.deleteProperty(target, property);
    },
  }) as T;
}
