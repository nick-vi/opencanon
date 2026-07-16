import { z } from "zod";
import { OpenCanonErrorPayloadSchema } from "./errors.ts";
import {
  CanonEventSchema,
  EngineVersionSchema,
  ProductModelProjectionCountsSchema,
  ProjectRefreshSchema,
} from "./contracts-governance.ts";
import { SemanticIndexSnapshotSchema } from "./contracts-semantic.ts";

export const RuntimeSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
});
export const RuntimeFailureSchema = z.object({
  ok: z.literal(false),
  error: OpenCanonErrorPayloadSchema,
});
export const RuntimeResponseSchema = z.union([RuntimeSuccessSchema, RuntimeFailureSchema]);
export type RuntimeResponse = z.infer<typeof RuntimeResponseSchema>;

export const RuntimeWorkerJobStatusValue = {
  Queued: "queued",
  Running: "running",
  Succeeded: "succeeded",
  Failed: "failed",
} as const;
export type RuntimeWorkerJobStatusValue = (typeof RuntimeWorkerJobStatusValue)[keyof typeof RuntimeWorkerJobStatusValue];

export const RuntimeWorkerJobKindValue = {
  ProjectAnalysis: "project-analysis",
  KnowledgeIndex: "knowledge-index",
  ProjectMap: "project-map",
  Doctor: "doctor",
} as const;
export type RuntimeWorkerJobKindValue = (typeof RuntimeWorkerJobKindValue)[keyof typeof RuntimeWorkerJobKindValue];

export const RuntimeWorkerJobSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    RuntimeWorkerJobKindValue.ProjectAnalysis,
    RuntimeWorkerJobKindValue.KnowledgeIndex,
    RuntimeWorkerJobKindValue.ProjectMap,
    RuntimeWorkerJobKindValue.Doctor,
  ]),
  status: z.enum([
    RuntimeWorkerJobStatusValue.Queued,
    RuntimeWorkerJobStatusValue.Running,
    RuntimeWorkerJobStatusValue.Succeeded,
    RuntimeWorkerJobStatusValue.Failed,
  ]),
  label: z.string().min(1),
  startedAt: z.string().datetime().optional(),
  finishedAt: z.string().datetime().optional(),
  current: z.number().int().min(0).optional(),
  total: z.number().int().min(0).optional(),
  unit: z.string().min(1).optional(),
  message: z.string().min(1).optional(),
});
export type RuntimeWorkerJob = z.infer<typeof RuntimeWorkerJobSchema>;

export const RuntimeLifecyclePhaseValue = {
  TransportReady: "transport-ready",
  Refreshing: "refreshing",
  Ready: "ready",
  Failed: "failed",
  Stopping: "stopping",
  Stopped: "stopped",
} as const;
export type RuntimeLifecyclePhaseValue = (typeof RuntimeLifecyclePhaseValue)[keyof typeof RuntimeLifecyclePhaseValue];

export const RuntimeRevisionSchema = z.object({
  observed: z.number().int().positive(),
  accepted: z.number().int().positive(),
  published: z.number().int().positive(),
});
export type RuntimeRevision = z.infer<typeof RuntimeRevisionSchema>;

const RuntimeLifecycleOperationSchema = z.object({
  revision: z.number().int().positive(),
  summary: z.string().min(1),
});

const RuntimeLifecycleExclusiveOperationSchema = z.object({
  label: z.string().min(1),
});

export const RuntimeLifecycleStateSchema = z.object({
  phase: z.enum([
    RuntimeLifecyclePhaseValue.TransportReady,
    RuntimeLifecyclePhaseValue.Refreshing,
    RuntimeLifecyclePhaseValue.Ready,
    RuntimeLifecyclePhaseValue.Failed,
    RuntimeLifecyclePhaseValue.Stopping,
    RuntimeLifecyclePhaseValue.Stopped,
  ]),
  revision: RuntimeRevisionSchema,
  settled: z.boolean(),
  active: RuntimeLifecycleOperationSchema.optional(),
  queued: RuntimeLifecycleOperationSchema.optional(),
  operation: RuntimeLifecycleExclusiveOperationSchema.optional(),
  failure: z.object({ revision: z.number().int().positive(), message: z.string().min(1) }).optional(),
});
export type RuntimeLifecycleState = z.infer<typeof RuntimeLifecycleStateSchema>;

export const RuntimeHealthSchema = z.object({
  status: z.enum(["ready", "missing", "indexing", "stale", "failed"]),
  process: z
    .object({
      kind: z.literal("runtime"),
      pid: z.number().int().positive(),
      leaseId: z.string().min(1),
    })
    .optional(),
  engine: EngineVersionSchema,
  refresh: ProjectRefreshSchema,
  startedAt: z.string().datetime(),
  jobs: z.array(RuntimeWorkerJobSchema).optional(),
  validatorGraph: z
    .object({
      entrypoint: z.string().min(1),
      hash: z.string().min(1),
      loadedAt: z.string().datetime(),
      validatorCount: z.number().int().min(0),
      dependencyFiles: z.array(z.string().min(1)).default([]),
    })
    .optional(),
});
export type RuntimeHealth = z.infer<typeof RuntimeHealthSchema>;

export const RuntimeValidatorGraphSummarySchema = z.object({
  hash: z.string().min(1),
  loadedAt: z.string().datetime(),
  validatorCount: z.number().int().min(0),
  dependencyCount: z.number().int().min(0),
});
export type RuntimeValidatorGraphSummary = z.infer<typeof RuntimeValidatorGraphSummarySchema>;

export const RuntimeHealthSummarySchema = RuntimeHealthSchema.omit({ validatorGraph: true }).extend({
  validatorGraph: RuntimeValidatorGraphSummarySchema.optional(),
});
export type RuntimeHealthSummary = z.infer<typeof RuntimeHealthSummarySchema>;

export function summarizeRuntimeHealth(health: RuntimeHealth): RuntimeHealthSummary {
  return RuntimeHealthSummarySchema.parse({
    ...health,
    ...(health.validatorGraph
      ? {
          validatorGraph: {
            hash: health.validatorGraph.hash,
            loadedAt: health.validatorGraph.loadedAt,
            validatorCount: health.validatorGraph.validatorCount,
            dependencyCount: health.validatorGraph.dependencyFiles.length,
          },
        }
      : {}),
  });
}

export const RuntimeProductModelStateSchema = ProductModelProjectionCountsSchema.extend({
  graphHash: z.string().min(1),
  definitionsHash: z.string().min(1),
  indexedAt: z.string().datetime(),
});
export type RuntimeProductModelState = z.infer<typeof RuntimeProductModelStateSchema>;

export const RuntimeStateSchema = z.object({
  health: RuntimeHealthSchema,
  files: z.number().int().min(0),
  findings: z.number().int().min(0),
  staleFiles: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
  cacheMisses: z.number().int().min(0),
  semanticIndex: SemanticIndexSnapshotSchema.optional(),
  productModel: RuntimeProductModelStateSchema.optional(),
});
export type RuntimeState = z.infer<typeof RuntimeStateSchema>;

export const RuntimeLiveStateSchema = RuntimeStateSchema.extend({
  lifecycle: RuntimeLifecycleStateSchema,
});
export type RuntimeLiveState = z.infer<typeof RuntimeLiveStateSchema>;

export const RuntimeProjectSummarySchema = z.object({
  rootDir: z.string().min(1),
  lifecycle: RuntimeLifecycleStateSchema,
  health: RuntimeHealthSummarySchema,
  files: z.number().int().min(0),
  findings: z.number().int().min(0),
  staleFiles: z.number().int().min(0),
  graphHash: z.string().min(1).optional(),
  lastIndexedAt: z.string().datetime().optional(),
  semanticIndex: SemanticIndexSnapshotSchema.optional(),
  productModel: RuntimeProductModelStateSchema.optional(),
  latestEvent: CanonEventSchema.optional(),
});
export type RuntimeProjectSummary = z.infer<typeof RuntimeProjectSummarySchema>;

export const RuntimeValidatorSummarySchema = z.object({
  id: z.string().min(1),
  severity: z.enum(["error", "warning"]),
  scope: z.enum(["file", "folder", "import-edge", "package", "project"]),
  domain: z.enum(["file", "import-edge", "impact-surface", "definition", "project", "custom"]),
  facts: z.array(z.string().min(1)),
  topics: z.array(z.string().min(1)),
  appliesScopes: z.array(z.array(z.string().min(1))),
  conventionIds: z.array(z.string().min(1)),
  docs: z.array(z.string().min(1)),
  summary: z.string().min(1).optional(),
}).strict();
export type RuntimeValidatorSummary = z.infer<typeof RuntimeValidatorSummarySchema>;

export const RuntimeValidatorCatalogSchema = z.object({
  validators: z.array(RuntimeValidatorSummarySchema),
  total: z.number().int().min(0),
  offset: z.number().int().min(0),
  limit: z.number().int().positive(),
}).strict();
export type RuntimeValidatorCatalog = z.infer<typeof RuntimeValidatorCatalogSchema>;

export const ValidateRequestSchema = z.object({
  files: z.array(z.string().min(1)).default([]),
  changed: z.boolean().default(false),
  all: z.boolean().default(false),
  strictWarnings: z.boolean().default(false),
  validatorIds: z.array(z.string().min(1)).default([]),
  topics: z.array(z.string().min(1)).default([]),
});
export type ValidateRequest = z.infer<typeof ValidateRequestSchema>;

export const ContextRequestSchema = z.object({
  files: z.array(z.string().min(1)).default([]),
  changed: z.boolean().default(false),
  query: z.string().min(1).optional(),
  topics: z.array(z.string().min(1)).default([]),
});
export type ContextRequest = z.infer<typeof ContextRequestSchema>;
