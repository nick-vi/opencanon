import type { Clock } from '@opencanon/observability/ports';

export class SystemClock implements Clock {
  now(): string {
    return new Date().toISOString();
  }
}
