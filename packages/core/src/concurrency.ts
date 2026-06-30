export class Semaphore {
  readonly capacity: number;
  private available: number;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) throw new Error("Semaphore capacity must be a positive integer.");
    this.capacity = capacity;
    this.available = capacity;
  }

  get active(): number {
    return this.capacity - this.available;
  }

  get queued(): number {
    return this.waiters.length;
  }

  async acquire(): Promise<() => void> {
    if (this.available > 0) {
      this.available -= 1;
      return () => this.release();
    }

    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
    return () => this.release();
  }

  async run<T>(change: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await change();
    } finally {
      release();
    }
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.available = Math.min(this.available + 1, this.capacity);
  }
}

export async function boundedMap<T, R>(items: Iterable<T>, concurrency: number, map: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const semaphore = new Semaphore(concurrency);
  const tasks = Array.from(items, (item, index) => semaphore.run(() => map(item, index)));
  return Promise.all(tasks);
}

export async function boundedMapSettled<T, R>(
  items: Iterable<T>,
  concurrency: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const semaphore = new Semaphore(concurrency);
  const tasks = Array.from(items, (item, index) => semaphore.run(() => map(item, index)));
  return Promise.allSettled(tasks);
}
