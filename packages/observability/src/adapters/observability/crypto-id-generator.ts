import { randomUUID } from 'node:crypto';
import type { IdGenerator } from '@opencanon/observability/ports';

export class CryptoIdGenerator implements IdGenerator {
  nextId(prefix: string): string {
    return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  }
}
