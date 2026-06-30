export function deepFreeze<T>(value: T): Readonly<T> {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value as Readonly<T>;

  Object.freeze(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== null && (typeof entry === 'object' || typeof entry === 'function')) {
      deepFreeze(entry);
    }
  }

  return value as Readonly<T>;
}

export function isDeeplyFrozen(value: unknown, visited = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (visited.has(value)) return true;
  if (!Object.isFrozen(value)) return false;

  visited.add(value);
  for (const key of Object.getOwnPropertyNames(value)) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== null && typeof entry === 'object' && !isDeeplyFrozen(entry, visited)) {
      return false;
    }
  }

  return true;
}
