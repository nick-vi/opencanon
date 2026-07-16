import type { RuntimeLifecycleState } from "@opencanon/core";

export const DefaultRuntimeShutdownTimeoutMs = 15_000;

export type RuntimeShutdownTask = {
  label: string;
  operation: Promise<unknown>;
};

export type RuntimeCleanupStep = {
  label: string;
  operation(): Promise<unknown> | unknown;
};

export function resolveRuntimeShutdownTimeout(timeoutMs = DefaultRuntimeShutdownTimeoutMs): number {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Project runtime shutdown timeout must be a positive number.");
  }
  return timeoutMs;
}

export async function drainRuntimeShutdown(input: {
  tasks: RuntimeShutdownTask[];
  timeoutMs: number;
  lifecycle(): RuntimeLifecycleState;
  finalize(): Promise<void>;
}): Promise<void> {
  const timeoutMs = resolveRuntimeShutdownTimeout(input.timeoutMs);
  const pending = new Set(input.tasks.map((task) => task.label));
  const tracked = input.tasks.map((task) => task.operation.finally(() => {
    pending.delete(task.label);
  }));
  const completion = Promise.allSettled(tracked).then(async (results) => {
    const failures = results
      .filter((result): result is PromiseRejectedResult => result.status === "rejected")
      .map((result) => result.reason);
    try {
      await input.finalize();
    } catch (error) {
      failures.push(error);
    }
    if (failures.length > 0) throw new AggregateError(failures, "One or more project runtime shutdown tasks failed.");
  });
  void completion.catch(() => undefined);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(new Error(
        `Project runtime shutdown did not settle within ${timeoutMs}ms. Pending: ${[...pending].join(", ") || "unknown"}. Current lifecycle: ${JSON.stringify(input.lifecycle())}.`,
      ));
    }, timeoutMs);
    timer.unref?.();
  });
  try {
    await Promise.race([completion, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function runRuntimeCleanup(steps: RuntimeCleanupStep[]): Promise<void> {
  const failures: unknown[] = [];
  for (const step of steps) {
    try {
      await step.operation();
    } catch (error) {
      failures.push(new Error(`${step.label} cleanup failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error }));
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, "One or more project runtime cleanup steps failed.");
}
