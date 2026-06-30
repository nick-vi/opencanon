export interface IdGenerator {
  nextId(prefix: string): string;
}
