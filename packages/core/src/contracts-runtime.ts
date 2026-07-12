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
  ProjectSnapshot: "project-snapshot",
  SemanticIndex: "semantic-index",
  ProjectMap: "project-map",
  Doctor: "doctor",
} as const;
export type RuntimeWorkerJobKindValue = (typeof RuntimeWorkerJobKindValue)[keyof typeof RuntimeWorkerJobKindValue];

export const RuntimeWorkerJobSchema = z.object({
  id: z.string().min(1),
  kind: z.enum([
    RuntimeWorkerJobKindValue.ProjectSnapshot,
    RuntimeWorkerJobKindValue.SemanticIndex,
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

export const RuntimeProjectSummarySchema = z.object({
  rootDir: z.string().min(1),
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
