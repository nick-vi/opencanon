import {
  isValidTraceFlags,
  isValidTraceId,
  sampledTraceFlags,
  traceFlagsSampled,
  unsampledTraceFlags,
} from './trace-context.ts';

export type TraceSamplingAttributes = Record<string, unknown>;

export const TraceSamplingDecision = Object.freeze({
  Drop: 'drop',
  RecordOnly: 'record_only',
  RecordAndSample: 'record_and_sample',
} as const);

export type TraceSamplingDecision =
  (typeof TraceSamplingDecision)[keyof typeof TraceSamplingDecision];

export type TraceSamplingParentContext = {
  traceId?: string | undefined;
  traceFlags?: string | undefined;
  traceState?: string | undefined;
  sampled?: boolean | undefined;
};

export type TraceSamplingInput = {
  traceId: string;
  name: string;
  kind?: string | undefined;
  attributes?: TraceSamplingAttributes | undefined;
  traceState?: string | undefined;
  parent?: TraceSamplingParentContext | undefined;
};

export type TraceSamplingResult = {
  decision: TraceSamplingDecision;
  reason: string;
  attributes?: TraceSamplingAttributes | undefined;
  traceState?: string | undefined;
};

export type TraceSampler = {
  readonly description: string;
  shouldSample(input: TraceSamplingInput): TraceSamplingResult;
};

const MAX_56_BIT_RANDOMNESS = 1n << 56n;
const TRACE_ID_RANDOMNESS_HEX_LENGTH = 14;

export const AlwaysOnTraceSampler: TraceSampler = Object.freeze({
  description: 'AlwaysOnSampler',
  shouldSample: (input) =>
    recordAndSample({
      reason: 'always_on',
      traceState: input.traceState ?? input.parent?.traceState,
    }),
});

export const AlwaysOffTraceSampler: TraceSampler = Object.freeze({
  description: 'AlwaysOffSampler',
  shouldSample: (input) =>
    drop({
      reason: 'always_off',
      traceState: input.traceState ?? input.parent?.traceState,
    }),
});

export const RecordOnlyTraceSampler: TraceSampler = Object.freeze({
  description: 'RecordOnlySampler',
  shouldSample: (input) =>
    recordOnly({
      reason: 'record_only',
      traceState: input.traceState ?? input.parent?.traceState,
    }),
});

export function createParentBasedTraceSampler(
  root: TraceSampler = AlwaysOnTraceSampler
): TraceSampler {
  return {
    description: `ParentBasedSampler{root=${root.description}}`,
    shouldSample(input) {
      const parentSampled = parentSampledFlag(input.parent);
      if (parentSampled === true) {
        return recordAndSample({
          reason: 'parent_sampled',
          traceState: input.traceState ?? input.parent?.traceState,
        });
      }
      if (parentSampled === false) {
        return drop({
          reason: 'parent_not_sampled',
          traceState: input.traceState ?? input.parent?.traceState,
        });
      }

      return root.shouldSample(input);
    },
  };
}

export function createTraceIdRatioSampler(ratio: number): TraceSampler {
  if (!Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    throw new TraceSamplingError('Trace sampling ratio must be between 0 and 1', { ratio });
  }

  if (ratio === 0) return AlwaysOffTraceSampler;
  if (ratio === 1) return AlwaysOnTraceSampler;

  const threshold = BigInt(Math.floor(Number(MAX_56_BIT_RANDOMNESS) * ratio));

  return {
    description: `TraceIdRatioSampler{${ratio}}`,
    shouldSample(input) {
      if (!isValidTraceId(input.traceId)) {
        throw new TraceSamplingError('Trace id is invalid', { traceId: input.traceId });
      }

      const randomness = traceIdRandomness(input.traceId);
      if (randomness < threshold) {
        return recordAndSample({
          reason: 'trace_id_ratio',
          traceState: input.traceState ?? input.parent?.traceState,
        });
      }

      return drop({
        reason: 'trace_id_ratio',
        traceState: input.traceState ?? input.parent?.traceState,
      });
    },
  };
}

export function drop(input: {
  reason: string;
  attributes?: TraceSamplingAttributes | undefined;
  traceState?: string | undefined;
}): TraceSamplingResult {
  return samplingResult(TraceSamplingDecision.Drop, input);
}

export function recordOnly(input: {
  reason: string;
  attributes?: TraceSamplingAttributes | undefined;
  traceState?: string | undefined;
}): TraceSamplingResult {
  return samplingResult(TraceSamplingDecision.RecordOnly, input);
}

export function recordAndSample(input: {
  reason: string;
  attributes?: TraceSamplingAttributes | undefined;
  traceState?: string | undefined;
}): TraceSamplingResult {
  return samplingResult(TraceSamplingDecision.RecordAndSample, input);
}

export function samplingDecisionRecords(decision: TraceSamplingDecision): boolean {
  return decision !== TraceSamplingDecision.Drop;
}

export function samplingDecisionSamples(decision: TraceSamplingDecision): boolean {
  return decision === TraceSamplingDecision.RecordAndSample;
}

export function traceFlagsForSamplingDecision(decision: TraceSamplingDecision): string {
  return samplingDecisionSamples(decision) ? sampledTraceFlags() : unsampledTraceFlags();
}

export class TraceSamplingError extends Error {
  override readonly name = 'TraceSamplingError';
  readonly details?: Record<string, unknown> | undefined;

  constructor(
    message: string,
    details?: Record<string, unknown> | undefined
  ) {
    super(message);
    this.details = details;
  }
}

function samplingResult(
  decision: TraceSamplingDecision,
  input: {
    reason: string;
    attributes?: TraceSamplingAttributes | undefined;
    traceState?: string | undefined;
  }
): TraceSamplingResult {
  return {
    decision,
    reason: input.reason,
    ...(input.attributes != null ? { attributes: input.attributes } : {}),
    ...(input.traceState != null ? { traceState: input.traceState } : {}),
  };
}

function parentSampledFlag(
  parent: TraceSamplingParentContext | undefined
): boolean | undefined {
  if (parent == null) return undefined;
  if (parent.sampled != null) return parent.sampled;
  if (parent.traceFlags == null) return undefined;
  if (!isValidTraceFlags(parent.traceFlags)) return undefined;
  return traceFlagsSampled(parent.traceFlags);
}

function traceIdRandomness(traceId: string): bigint {
  return BigInt(`0x${traceId.slice(-TRACE_ID_RANDOMNESS_HEX_LENGTH)}`);
}
