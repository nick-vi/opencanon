export type RuntimeActivityTracker = {
  begin(label: string): () => void;
  count(): number;
  labels(): string[];
};

export function createRuntimeActivityTracker(onChange: () => void = () => undefined): RuntimeActivityTracker {
  const leases = new Map<symbol, string>();
  return {
    begin(label) {
      const id = Symbol(label);
      leases.set(id, label);
      onChange();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        leases.delete(id);
        onChange();
      };
    },
    count: () => leases.size,
    labels: () => [...leases.values()],
  };
}
