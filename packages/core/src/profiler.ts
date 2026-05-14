export type ProfileEntry = {
  name: string;
  ms: number;
  count: number;
};

export type Profiler = {
  enabled: boolean;
  measure<T>(name: string, fn: () => T): T;
  measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T>;
  add(name: string, ms: number, count?: number): void;
  entries(): ProfileEntry[];
};

export function createProfiler(enabled: boolean): Profiler {
  const entries = new Map<string, ProfileEntry>();

  function add(name: string, ms: number, count = 1): void {
    if (!enabled) return;
    const current = entries.get(name);
    if (current) {
      current.ms += ms;
      current.count += count;
      return;
    }
    entries.set(name, { name, ms, count });
  }

  return {
    enabled,
    measure<T>(name: string, fn: () => T): T {
      if (!enabled) return fn();
      const start = performance.now();
      try {
        return fn();
      } finally {
        add(name, performance.now() - start);
      }
    },
    async measureAsync<T>(name: string, fn: () => Promise<T>): Promise<T> {
      if (!enabled) return fn();
      const start = performance.now();
      try {
        return await fn();
      } finally {
        add(name, performance.now() - start);
      }
    },
    add,
    entries() {
      return [...entries.values()]
        .map((entry) => ({ ...entry, ms: Number(entry.ms.toFixed(3)) }))
        .sort((left, right) => right.ms - left.ms || left.name.localeCompare(right.name));
    },
  };
}

export function renderProfileMarkdown(entries: ProfileEntry[]): string {
  const lines: string[] = [];
  lines.push("## Profile");
  lines.push("");
  if (entries.length === 0) {
    lines.push("- No profile data collected.");
    return lines.join("\n");
  }
  for (const entry of entries) lines.push(`- ${entry.name}: ${entry.ms.toFixed(3)}ms (${entry.count})`);
  return lines.join("\n");
}
