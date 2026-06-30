import type { Logger } from '@opencanon/observability/ports';

export class NoopLogger implements Logger {
  trace(): void {}
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
  fatal(): void {}
  child(): Logger {
    return this;
  }
  async flush(): Promise<void> {}
  async close(): Promise<void> {}
}
