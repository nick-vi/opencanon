import { z } from "zod";

export const DomainProtocolVersion = 1 as const;
const PositiveSafeIntegerSchema = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);
const NonNegativeSafeIntegerSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const ProtocolHeader = {
  IdempotencyKey: "idempotency-key",
  Version: "x-opencanon-protocol-version",
} as const;

export const ProtocolOperationKind = {
  Query: "query",
  Command: "command",
  Stream: "stream",
} as const;
export type ProtocolOperationKind = (typeof ProtocolOperationKind)[keyof typeof ProtocolOperationKind];

export const ProtocolHttpMethod = {
  Get: "GET",
  Post: "POST",
} as const;
export type ProtocolHttpMethod = (typeof ProtocolHttpMethod)[keyof typeof ProtocolHttpMethod];

export const ProtocolAuthorization = {
  Public: "public",
  Project: "project",
} as const;
export type ProtocolAuthorization = (typeof ProtocolAuthorization)[keyof typeof ProtocolAuthorization];

export const ProtocolConsistency = {
  Lifecycle: "lifecycle",
  Published: "published",
} as const;
export type ProtocolConsistency = (typeof ProtocolConsistency)[keyof typeof ProtocolConsistency];

export const ProtocolCost = {
  Tiny: "tiny",
  Bounded: "bounded",
  Operation: "operation",
} as const;
export type ProtocolCost = (typeof ProtocolCost)[keyof typeof ProtocolCost];

export const ProtocolIdempotency = {
  Safe: "safe",
  Keyed: "keyed",
  Unsafe: "unsafe",
} as const;
export type ProtocolIdempotency = (typeof ProtocolIdempotency)[keyof typeof ProtocolIdempotency];

export const ProtocolDomain = {
  Project: "project",
  Canon: "canon",
  Proof: "proof",
  Knowledge: "knowledge",
  Activity: "activity",
  Health: "health",
} as const;
export type ProtocolDomain = (typeof ProtocolDomain)[keyof typeof ProtocolDomain];

export const ProtocolOperationKindSchema = z.enum(Object.values(ProtocolOperationKind));
export const ProtocolHttpMethodSchema = z.enum(Object.values(ProtocolHttpMethod));
export const ProtocolAuthorizationSchema = z.enum(Object.values(ProtocolAuthorization));
export const ProtocolConsistencySchema = z.enum(Object.values(ProtocolConsistency));
export const ProtocolCostSchema = z.enum(Object.values(ProtocolCost));
export const ProtocolIdempotencySchema = z.enum(Object.values(ProtocolIdempotency));
export const ProtocolDomainSchema = z.enum(Object.values(ProtocolDomain));

export const ProtocolLimitsSchema = z.object({
  requestBytes: z.number().int().positive(),
  responseBytes: z.number().int().positive(),
  concurrency: z.number().int().positive(),
}).strict();
export type ProtocolLimits = z.infer<typeof ProtocolLimitsSchema>;

export const ProtocolIdempotencyKeyBindingSchema = z.object({
  source: z.literal("body"),
  path: z.array(z.string().min(1).max(128)).min(1).max(8),
}).strict();
export type ProtocolIdempotencyKeyBinding = z.infer<typeof ProtocolIdempotencyKeyBindingSchema>;

const ProtocolOperationMetadataBaseSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/),
  version: z.literal(DomainProtocolVersion),
  kind: ProtocolOperationKindSchema,
  method: ProtocolHttpMethodSchema,
  path: z.string().regex(/^\/api\/[a-z0-9][a-z0-9/-]*$/),
  authorization: ProtocolAuthorizationSchema,
  consistency: ProtocolConsistencySchema,
  cost: ProtocolCostSchema,
  cancellable: z.boolean(),
  limits: ProtocolLimitsSchema,
  span: z.string().regex(/^opencanon\.[a-z][a-z0-9.-]*$/),
}).strict();

export const ProtocolOperationMetadataSchema = z.discriminatedUnion("idempotency", [
  ProtocolOperationMetadataBaseSchema.extend({
    idempotency: z.literal(ProtocolIdempotency.Keyed),
    idempotencyKey: ProtocolIdempotencyKeyBindingSchema,
  }).strict(),
  ProtocolOperationMetadataBaseSchema.extend({
    idempotency: z.union([z.literal(ProtocolIdempotency.Safe), z.literal(ProtocolIdempotency.Unsafe)]),
  }).strict(),
]);
export type ProtocolOperationMetadata = z.infer<typeof ProtocolOperationMetadataSchema>;

export const ProtocolQueryValueSchema = z.union([z.string(), z.array(z.string())]);
export const ProtocolInputSchema = z.object({
  query: z.record(z.string(), ProtocolQueryValueSchema).optional(),
  body: z.json().optional(),
}).strict();
export type ProtocolInput = {
  query?: Record<string, string | string[]>;
  body?: unknown;
};
export type ParsedProtocolInput = z.output<typeof ProtocolInputSchema>;

type ProtocolOperationPolicy = ProtocolOperationMetadata extends infer TMetadata
  ? TMetadata extends ProtocolOperationMetadata
    ? Omit<TMetadata, "id">
    : never
  : never;

export type ProtocolOperationDefinition<
  TId extends string = string,
  TInput extends z.ZodType = z.ZodType,
  TOutput extends z.ZodType = z.ZodType,
> = Readonly<ProtocolOperationPolicy & {
  id: TId;
  inputSchema: TInput;
  outputSchema: TOutput;
}>;

type ProtocolOperationDefinitionInput<
  TId extends string,
  TInput extends z.ZodType,
  TOutput extends z.ZodType,
> = ProtocolOperationPolicy & {
  id: TId;
  inputSchema: TInput;
  outputSchema: TOutput;
};

export function defineProtocolOperation<
  const TId extends string,
  const TInput extends z.ZodType,
  const TOutput extends z.ZodType,
>(definition: ProtocolOperationDefinitionInput<TId, TInput, TOutput>): ProtocolOperationDefinition<TId, TInput, TOutput> {
  ProtocolOperationMetadataSchema.parse(operationMetadata(definition));
  return Object.freeze(definition);
}

export function operationMetadata(operation: ProtocolOperationDefinition): ProtocolOperationMetadata {
  const metadata = {
    id: operation.id,
    version: operation.version,
    kind: operation.kind,
    method: operation.method,
    path: operation.path,
    authorization: operation.authorization,
    consistency: operation.consistency,
    cost: operation.cost,
    idempotency: operation.idempotency,
    ...(operation.idempotency === ProtocolIdempotency.Keyed ? { idempotencyKey: operation.idempotencyKey } : {}),
    cancellable: operation.cancellable,
    limits: operation.limits,
    span: operation.span,
  };
  return ProtocolOperationMetadataSchema.parse(metadata);
}

export function ProjectionResponseSchema<TSchema extends z.ZodType>(dataSchema: TSchema) {
  return z.object({
    protocolVersion: z.literal(DomainProtocolVersion),
    revision: PositiveSafeIntegerSchema,
    data: dataSchema,
    nextCursor: z.string().min(1).optional(),
  }).strict();
}

export type ProjectionResponse<T> = {
  protocolVersion: typeof DomainProtocolVersion;
  revision: number;
  data: T;
  nextCursor?: string;
};

export function protocolProjection<T>(revision: number, data: T, nextCursor?: string): ProjectionResponse<T> {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Protocol projections require a positive safe published revision.");
  return {
    protocolVersion: DomainProtocolVersion,
    revision,
    data,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

const UnknownProjectionResponseSchema = ProjectionResponseSchema(z.unknown());

export function parseProjectionResponse<T>(value: unknown): ProjectionResponse<T> {
  return UnknownProjectionResponseSchema.parse(value) as ProjectionResponse<T>;
}

export const ProtocolProgressSchema = z.object({
  operation: z.string().min(1).max(128),
  phase: z.string().min(1).max(128),
  current: z.number().int().min(0),
  total: z.number().int().min(0),
  unit: z.string().min(1).max(64),
  message: z.string().min(1).max(512).optional(),
}).strict();
export type ProtocolProgress = z.infer<typeof ProtocolProgressSchema>;

export const ProjectProtocolEventSchema = z.object({
  protocolVersion: z.literal(DomainProtocolVersion),
  sequence: PositiveSafeIntegerSchema,
  timestamp: z.string().datetime(),
  revision: PositiveSafeIntegerSchema,
  domain: ProtocolDomainSchema,
  type: z.string().min(1).max(64),
  summary: z.string().min(1).max(2_048),
  ids: z.array(z.string().min(1).max(256)).max(128),
  operationId: z.string().min(1).max(256).optional(),
  progress: ProtocolProgressSchema.optional(),
}).strict();
export type ProjectProtocolEvent = z.infer<typeof ProjectProtocolEventSchema>;

export const ProjectProtocolEventDraftSchema = ProjectProtocolEventSchema.omit({
  sequence: true,
  timestamp: true,
  revision: true,
});
export type ProjectProtocolEventDraft = z.infer<typeof ProjectProtocolEventDraftSchema>;

export const PersistedProjectProtocolEventDraftSchema = ProjectProtocolEventSchema.omit({ sequence: true });
export type PersistedProjectProtocolEventDraft = z.infer<typeof PersistedProjectProtocolEventDraftSchema>;

export const ProtocolEventReplaySchema = z.object({
  events: z.array(ProjectProtocolEventSchema),
  latestSequence: NonNegativeSafeIntegerSchema,
  oldestAvailableSequence: PositiveSafeIntegerSchema.optional(),
  resyncRequired: z.boolean(),
  revision: PositiveSafeIntegerSchema,
}).strict();
export type ProtocolEventReplay = z.infer<typeof ProtocolEventReplaySchema>;

export const ProtocolEventWindowSchema = z.object({
  events: z.array(ProjectProtocolEventSchema),
  latestSequence: NonNegativeSafeIntegerSchema,
  oldestAvailableSequence: PositiveSafeIntegerSchema.optional(),
}).strict();
export type ProtocolEventWindow = z.infer<typeof ProtocolEventWindowSchema>;
