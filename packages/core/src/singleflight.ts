export class Singleflight {
  private readonly inflight = new Map<string, Promise<unknown>>();

  get size(): number {
    return this.inflight.size;
  }

  has(key: string): boolean {
    return this.inflight.has(key);
  }

  async run<T>(key: string, run: () => Promise<T>): Promise<T> {
    const existing = this.inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = run().finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, promise);
    return promise;
  }

  clear(): void {
    this.inflight.clear();
  }
}
