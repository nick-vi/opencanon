type BranchCase = {
  matched: () => boolean;
  evaluate: () => unknown;
};

function valueOrFactory<T>(value: T | (() => T)): T {
  return typeof value === "function" ? (value as () => T)() : value;
}

export class BranchBuilder<T = never> {
  private readonly cases: BranchCase[] = [];

  when<R>(condition: boolean, value: R | (() => R)): BranchBuilder<T | R> {
    this.cases.push({
      matched: () => condition,
      evaluate: () => valueOrFactory(value),
    });
    return this as unknown as BranchBuilder<T | R>;
  }

  present<Value, R>(value: Value | null | undefined, map: (value: NonNullable<Value>) => R): BranchBuilder<T | R> {
    this.cases.push({
      matched: () => value !== null && value !== undefined,
      evaluate: () => map(value as NonNullable<Value>),
    });
    return this as unknown as BranchBuilder<T | R>;
  }

  else<R>(fallback: R | (() => R)): T | R {
    for (const branchCase of this.cases) {
      if (branchCase.matched()) return branchCase.evaluate() as T | R;
    }
    return valueOrFactory(fallback) as T | R;
  }
}

export function branch<T = never>(): BranchBuilder<T> {
  return new BranchBuilder<T>();
}
