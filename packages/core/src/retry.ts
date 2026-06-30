export const RetryJitterMode = {
  FULL: "full",
  NONE: "none",
} as const;
export type RetryJitterMode = (typeof RetryJitterMode)[keyof typeof RetryJitterMode];

export type RetryPolicy = {
  maxRetries: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  jitter?: RetryJitterMode | ((delayMs: number) => number);
  shouldRetry?: (error: unknown, attempt: number) => boolean;
  retryDelay?: (error: unknown, attempt: number, computedDelayMs: number) => number;
  onRetry?: (error: unknown, attempt: number, delayMs: number) => void;
};

export class RetryExhaustedError extends Error {
  override readonly name = "RetryExhaustedError";
  readonly attempts: number;
  readonly lastError: unknown;
  readonly errors: unknown[];

  constructor(attempts: number, lastError: unknown, errors: unknown[]) {
    super(`Retry exhausted after ${attempts} attempts.`, { cause: lastError });
    this.attempts = attempts;
    this.lastError = lastError;
    this.errors = errors;
  }
}

export async function withRetry<T>(run: () => Promise<T>, policy: RetryPolicy): Promise<T> {
  const {
    maxRetries,
    baseDelayMs = 1_000,
    maxDelayMs = 30_000,
    jitter = RetryJitterMode.FULL,
    shouldRetry,
    retryDelay,
    onRetry,
  } = policy;
  if (!Number.isInteger(maxRetries) || maxRetries < 0) throw new Error("maxRetries must be a non-negative integer.");
  if (baseDelayMs < 0) throw new Error("baseDelayMs must be non-negative.");
  if (maxDelayMs < 0) throw new Error("maxDelayMs must be non-negative.");

  const errors: unknown[] = [];
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      errors.push(error);
      if (shouldRetry && !shouldRetry(error, attempt)) throw error;
      if (attempt === maxRetries) throw new RetryExhaustedError(attempt + 1, error, errors);

      const backoffMs = Math.min(baseDelayMs * 2 ** attempt, maxDelayMs);
      const jitteredMs = applyRetryJitter(backoffMs, jitter);
      const delayMs = Math.max(0, Math.min(retryDelay ? retryDelay(error, attempt, jitteredMs) : jitteredMs, maxDelayMs));
      try {
        onRetry?.(error, attempt, delayMs);
      } catch {
        // Retry callbacks are observational and must not change retry behavior.
      }
      await sleep(delayMs);
    }
  }

  throw new RetryExhaustedError(maxRetries + 1, errors[errors.length - 1], errors);
}

function applyRetryJitter(delayMs: number, jitter: RetryPolicy["jitter"]): number {
  if (jitter === RetryJitterMode.NONE) return delayMs;
  if (!jitter || jitter === RetryJitterMode.FULL) return Math.random() * delayMs;
  return jitter(delayMs);
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
