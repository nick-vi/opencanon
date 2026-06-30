import assert from "node:assert/strict";
import { test } from "vitest";
import { NoopLogger, SimpleTracer, SpanKind, type Clock, type IdGenerator } from "@opencanon/observability";
import { createProjectObservabilityExporter } from "@opencanon/runtime";
import type { ObservabilityRecordBatch } from "@opencanon/engine";

test("project observability exporter persists tracer callbacks through the store boundary", async () => {
  const writes: ObservabilityRecordBatch[] = [];
  const exporter = createProjectObservabilityExporter({
    writeObservabilityRecords(records) {
      writes.push(records);
    },
  });
  const tracer = new SimpleTracer(new NoopLogger(), {
    clock: new StepClock("2026-01-01T00:00:00.000Z"),
    ids: new SequentialIds(),
    exporters: [exporter],
  });

  await tracer.span("doctor.run", { kind: SpanKind.TASK }, (span) => {
    span.addEvent("doctor.check", { check: "state" });
  });

  assert.equal(writes.filter((write) => write.traces != null).length, 2);
  assert.equal(writes.filter((write) => write.spans != null).length, 2);
  assert.equal(writes.filter((write) => write.events != null).length, 1);
  assert.equal(writes.at(-1)?.traces?.[0]?.status, "ok");
});

class StepClock implements Clock {
  private epochMs: number;

  constructor(start: string) {
    this.epochMs = Date.parse(start);
  }

  now(): string {
    const value = new Date(this.epochMs).toISOString();
    this.epochMs += 5;
    return value;
  }
}

class SequentialIds implements IdGenerator {
  private next = 1;

  nextId(prefix: string): string {
    return `${prefix}_${this.next++}`;
  }
}
