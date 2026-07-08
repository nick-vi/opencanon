import { z } from "zod";
import {
  DiagnosticSeverity,
  FactDiagnosticSchema,
  FactKindSchema,
  FileFactsSchema,
  LanguageSchema,
  RepoGraphSchema,
  ValidatorScopeSchema,
  diagnosticSeverityValues,
  validatorSeverityValues,
} from "./contracts-facts.ts";

export const ValidatorContractSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  topics: z.array(z.string().min(1)).min(1),
  severity: z.enum(validatorSeverityValues),
  scope: ValidatorScopeSchema,
  domain: z.enum(["file", "import-edge", "impact-surface", "definition", "project", "custom"]).default("file"),
  applies: z.array(z.string().min(1)).default([]),
  analysis: z.array(z.string().min(1)).default([]),
  facts: z.array(FactKindSchema).default([]),
  conventionIds: z.array(z.string().min(1)).default([]),
  docs: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1).optional(),
});
export type ValidatorContract = z.infer<typeof ValidatorContractSchema>;

export const FindingKindSchema = z.enum(["violation", "warning", "recommendation", "insight"]);
export type FindingKind = z.infer<typeof FindingKindSchema>;

export const CanonFixSchema = z.object({
  type: z.enum(["safe", "unsafe", "manual"]),
  command: z.string().min(1).optional(),
  description: z.string().min(1),
});
export type CanonFix = z.infer<typeof CanonFixSchema>;

export const CanonFindingSchema = z.object({
  id: z.string().min(1),
  kind: FindingKindSchema,
  severity: z.enum(diagnosticSeverityValues),
  validatorId: z.string().min(1).optional(),
  title: z.string().min(1),
  message: z.string().min(1),
  file: z.string().min(1).optional(),
  line: z.number().int().min(1).optional(),
  column: z.number().int().min(1).optional(),
  docs: z.array(z.string().min(1)).default([]),
  conventionIds: z.array(z.string().min(1)).default([]),
  introducedBy: z.string().min(1).optional(),
  resolvedBy: z.string().min(1).optional(),
  fix: CanonFixSchema.optional(),
});
export type CanonFinding = z.infer<typeof CanonFindingSchema>;

export const RecommendationSchema = CanonFindingSchema.extend({
  kind: z.literal("recommendation"),
  severity: z.literal(DiagnosticSeverity.Info),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const ChangePolicySchema = z.object({
  requiresTests: z.array(z.string().min(1)).default([]),
  requiresDocs: z.array(z.string().min(1)).default([]),
  requiresApproval: z.boolean().default(false),
  reviewers: z.array(z.string().min(1)).default([]),
});
export type ChangePolicy = z.infer<typeof ChangePolicySchema>;

export const ImpactSurfaceSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  title: z.string().min(1).optional(),
  applies: z.array(z.string().min(1)).min(1),
  owns: z.array(z.string().min(1)).default([]),
  dependsOn: z.array(z.string().min(1)).default([]),
  downstream: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  changePolicy: ChangePolicySchema.default({
    requiresTests: [],
    requiresDocs: [],
    requiresApproval: false,
    reviewers: [],
  }),
  docs: z.array(z.string().min(1)).default([]),
  conventionIds: z.array(z.string().min(1)).default([]),
  proposed: z.boolean().default(false),
});
export type ImpactSurface = z.infer<typeof ImpactSurfaceSchema>;

export const ProposedImpactNoteSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  title: z.string().min(1),
  applies: z.array(z.string().min(1)).min(1),
  evidence: z.array(z.string().min(1)).min(1),
  owns: z.array(z.string().min(1)).default([]),
  downstream: z.array(z.string().min(1)).default([]),
  risks: z.array(z.string().min(1)).default([]),
  createdAt: z.string().min(1),
  createdBy: z.string().min(1).optional(),
  docs: z.array(z.string().min(1)).default([]),
  conventionIds: z.array(z.string().min(1)).default([]),
});
export type ProposedImpactNote = z.infer<typeof ProposedImpactNoteSchema>;

export const DomainEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  kind: z.enum(["owns", "depends-on", "downstream"]),
  surfaceId: z.string().min(1),
});
export type DomainEdge = z.infer<typeof DomainEdgeSchema>;

export const BaselineFindingSchema = z.object({
  key: z.string().min(1),
  validatorId: z.string().min(1),
  file: z.string().min(1),
  line: z.number().int().min(1).optional(),
  message: z.string().min(1),
});
export type BaselineFinding = z.infer<typeof BaselineFindingSchema>;

export const BaselineSchema = z.object({
  version: z.literal(1).default(1),
  findings: z.array(BaselineFindingSchema).default([]),
});
export type Baseline = z.infer<typeof BaselineSchema>;

export const externalToolMissingSeverityValues = ["error", "warning", "ignore"] as const;
/** Member value-set so code references members instead of inlining the raw strings. */
export const ExternalToolMissingSeverity = { Error: "error", Warning: "warning", Ignore: "ignore" } as const;
export type ExternalToolMissingSeverity = (typeof ExternalToolMissingSeverity)[keyof typeof ExternalToolMissingSeverity];
export const ExternalToolCommandSchema = z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]);
export const ExternalToolDefinitionSchema = z
  .object({
    command: ExternalToolCommandSchema,
    required: z.boolean().optional(),
    missingSeverity: z.enum(externalToolMissingSeverityValues).optional(),
    versionArgs: z.array(z.string().min(1)).min(1).optional(),
    timeoutMs: z.number().int().min(1).optional(),
  })
  .strict();
export const ExternalToolSchema = z.union([ExternalToolCommandSchema, ExternalToolDefinitionSchema]);
export type ExternalTool = z.infer<typeof ExternalToolSchema>;

export const DocSnippetSchema = z.object({
  source: z.string().min(1),
  path: z.string().min(1),
  slug: z.string().min(1),
  heading: z.string().min(1),
  level: z.number().int().min(1).max(6),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  body: z.string(),
  conventionIds: z.array(z.string().min(1)).default([]),
  contentHash: z.string().min(1),
});
export type CanonDocSnippet = z.infer<typeof DocSnippetSchema>;

export const CanonEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum([
    "created",
    "updated",
    "superseded",
    "enforced",
    "violated",
    "fixed",
    "recommended",
    "indexed",
    "change-started",
    "change-review",
    "change-blocked",
    "change-ready",
    "change-closed",
    "check-started",
    "check-passed",
    "check-failed",
    "task-claimed",
    "task-started",
    "task-review",
    "task-blocked",
    "task-ready",
    "task-closed",
    "task-check-started",
    "task-check-passed",
    "task-check-failed",
  ]),
  timestamp: z.string().datetime(),
  actor: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
  files: z.array(z.string().min(1)).default([]),
  changeIds: z.array(z.string().min(1)).default([]),
  taskIds: z.array(z.string().min(1)).default([]),
  checkIds: z.array(z.string().min(1)).default([]),
  conventionIds: z.array(z.string().min(1)).default([]),
  validatorIds: z.array(z.string().min(1)).default([]),
  findingIds: z.array(z.string().min(1)).default([]),
  summary: z.string().min(1),
});
export type CanonEvent = z.infer<typeof CanonEventSchema>;

export const EngineVersionSchema = z.object({
  packageVersion: z.string().min(1),
  engineVersion: z.string().min(1),
  napiVersion: z.string().min(1),
  schemaVersion: z.number().int().min(1),
});
export type EngineVersion = z.infer<typeof EngineVersionSchema>;

export const ResolvedProjectSettingsSchema = z.object({
  docsDir: z.string().min(1),
  conventionsPath: z.string().min(1),
  areasPath: z.string().min(1).default("opencanon/areas/index.ts"),
  specsPath: z.string().min(1).default("opencanon/specs/index.ts"),
  changesPath: z.string().min(1).default("opencanon/changes/index.ts"),
  fixturesDir: z.string().min(1),
  impactSurfacesPath: z.string().min(1).default("docs/opencanon/impact-surfaces.json"),
  proposedImpactNotesPath: z.string().min(1).default("docs/opencanon/proposed-impact-notes.json"),
  baselinePath: z.string().min(1).default(".opencanon/baseline.json"),
  commitApprovalsPath: z.string().min(1).default(".opencanon/commit-approvals.json"),
  commitApprovalsPersistent: z.boolean().default(false),
  projectFilePatterns: z.array(z.string().min(1)),
  ignore: z.array(z.string().min(1)),
  entrypoints: z.array(z.string().min(1)).default([]),
  publicSurfaces: z.array(z.string().min(1)).default([]),
  generated: z.array(z.string().min(1)).default([]),
  externalTools: z.record(z.string(), ExternalToolSchema).default({}),
  maxFiles: z.number().int().min(0),
  maxFileSizeKb: z.number().int().min(0),
  fileDiscovery: z.enum(["git", "filesystem"]),
  configHash: z.string().min(1),
});
export type ResolvedProjectSettings = z.infer<typeof ResolvedProjectSettingsSchema>;
export type ResolvedProjectSettingsInput = z.input<typeof ResolvedProjectSettingsSchema>;

export const OpenProjectRequestSchema = z.object({
  rootDir: z.string().min(1),
  statePath: z.string().min(1),
  settings: ResolvedProjectSettingsSchema,
});
export type OpenProjectRequest = z.input<typeof OpenProjectRequestSchema>;

export const ProjectRefreshStatusValue = {
  Live: "live",
  Stale: "stale",
} as const;
export type ProjectRefreshStatusValue = (typeof ProjectRefreshStatusValue)[keyof typeof ProjectRefreshStatusValue];

export const ProjectRefreshModeValue = {
  Watch: "watch",
  Manual: "manual",
} as const;
export type ProjectRefreshModeValue = (typeof ProjectRefreshModeValue)[keyof typeof ProjectRefreshModeValue];

export const ProjectRefreshSchema = z.object({
  status: z.enum([ProjectRefreshStatusValue.Live, ProjectRefreshStatusValue.Stale]),
  mode: z.enum([ProjectRefreshModeValue.Watch, ProjectRefreshModeValue.Manual]),
  bufferedEvents: z.number().int().min(0),
  reason: z.string().min(1).optional(),
});
export type ProjectRefresh = z.infer<typeof ProjectRefreshSchema>;

export const EngineProjectStatusSchema = z.object({
  rootDir: z.string().min(1),
  statePath: z.string().min(1),
  schemaVersion: z.number().int().min(1),
  migrationsApplied: z.array(z.number().int().min(1)),
  refresh: ProjectRefreshSchema,
});
export type EngineProjectStatus = z.infer<typeof EngineProjectStatusSchema>;

export const ScanAndDiffRequestSchema = z.object({
  files: z.array(z.string().min(1)),
});
export type ScanAndDiffRequest = z.infer<typeof ScanAndDiffRequestSchema>;

export const WatcherStartRequestSchema = z.object({
  debounceMs: z.number().int().min(25).max(5_000).default(250),
  bufferCapacity: z.number().int().min(1).max(1_024).default(128),
});
export type WatcherStartRequest = z.input<typeof WatcherStartRequestSchema>;

export const WatcherStartResultSchema = z.object({
  running: z.boolean(),
  debounceMs: z.number().int().min(25).max(5_000),
  bufferCapacity: z.number().int().min(1).max(1_024),
});
export type WatcherStartResult = z.infer<typeof WatcherStartResultSchema>;

export const WatcherEventBatchSchema = z.object({
  rootDir: z.string().min(1),
  paths: z.array(z.string().min(1)),
  stale: z.boolean(),
  reason: z.string().min(1).optional(),
  timestamp: z.string().min(1),
});
export type WatcherEventBatch = z.infer<typeof WatcherEventBatchSchema>;

export const ScanAndDiffResultSchema = z.object({
  statePath: z.string().min(1),
  schemaVersion: z.number().int().min(1),
  inventoryHash: z.string().min(1),
  files: z.array(
    z.object({
      path: z.string().min(1),
      contentHash: z.string().min(1),
      size: z.number().int().min(0),
      stale: z.boolean(),
    }),
  ),
  changedFiles: z.array(z.string().min(1)),
  unchangedFiles: z.array(z.string().min(1)),
  deletedFiles: z.array(z.string().min(1)),
  staleFiles: z.number().int().min(0),
});
export type ScanAndDiffResult = z.infer<typeof ScanAndDiffResultSchema>;

export const ProductModelDefinitionGraphSchema = z.object({
  nodes: z.array(
    z.object({
      id: z.string().min(1),
      kind: z.string().min(1),
      label: z.string().min(1),
    }),
  ),
  edges: z.array(
    z.object({
      from: z.string().min(1),
      to: z.string().min(1),
      kind: z.string().min(1),
      label: z.string().min(1).optional(),
    }),
  ),
  diagnostics: z.array(
    z.object({
      severity: z.enum(validatorSeverityValues),
      code: z.string().min(1),
      message: z.string().min(1),
      from: z.string().min(1).optional(),
      to: z.string().min(1).optional(),
    }),
  ),
  fileCoverage: z.record(
    z.string(),
    z.object({
      areas: z.array(z.string().min(1)),
      specs: z.array(z.string().min(1)),
      changes: z.array(z.string().min(1)),
      conventions: z.array(z.string().min(1)),
      surfaces: z.array(z.string().min(1)),
    }),
  ),
  backlinks: z.object({
    areaToSurfaces: z.record(z.string(), z.array(z.string().min(1))),
    specToSurfaces: z.record(z.string(), z.array(z.string().min(1))),
    changeToSurfaces: z.record(z.string(), z.array(z.string().min(1))),
    surfaceToAreas: z.record(z.string(), z.array(z.string().min(1))),
    surfaceToSpecs: z.record(z.string(), z.array(z.string().min(1))),
    surfaceToChanges: z.record(z.string(), z.array(z.string().min(1))),
    surfaceToConventions: z.record(z.string(), z.array(z.string().min(1))),
  }),
});
export type ProductModelDefinitionGraph = z.infer<typeof ProductModelDefinitionGraphSchema>;

export const ProductModelProjectionCountsSchema = z.object({
  areas: z.number().int().min(0),
  specs: z.number().int().min(0),
  changes: z.number().int().min(0),
  conventions: z.number().int().min(0),
  impactSurfaces: z.number().int().min(0),
  validators: z.number().int().min(0),
  nodes: z.number().int().min(0),
  edges: z.number().int().min(0),
  diagnostics: z.number().int().min(0),
});
export type ProductModelProjectionCounts = z.infer<typeof ProductModelProjectionCountsSchema>;

export const ProductModelProjectionSchema = z.object({
  indexedAt: z.string().datetime(),
  graphHash: z.string().min(1),
  definitionsHash: z.string().min(1),
  counts: ProductModelProjectionCountsSchema,
  areas: z.array(z.unknown()),
  specs: z.array(z.unknown()),
  changes: z.array(z.unknown()),
  conventions: z.array(z.unknown()),
  impactSurfaces: z.array(z.unknown()),
  validators: z.array(z.unknown()),
  definitionGraph: ProductModelDefinitionGraphSchema,
});
export type ProductModelProjection = z.infer<typeof ProductModelProjectionSchema>;

export const WriteProductModelProjectionRequestSchema = z.object({
  projection: ProductModelProjectionSchema,
});
export type WriteProductModelProjectionRequest = z.infer<typeof WriteProductModelProjectionRequestSchema>;

export const ReadProductModelProjectionResultSchema = z.object({
  projection: ProductModelProjectionSchema.nullable(),
});
export type ReadProductModelProjectionResult = z.infer<typeof ReadProductModelProjectionResultSchema>;
