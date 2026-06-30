import { z } from "zod";
import { OpenCanonDiagnosticSchema, OpenCanonErrorPayloadSchema } from "./errors.ts";

export const validatorScopeValues = ["file", "folder", "import-edge", "package", "project"] as const;
export const ValidatorScopeSchema = z.enum(validatorScopeValues);
export type ValidatorScope = z.infer<typeof ValidatorScopeSchema>;

export const factKindValues = ["imports", "exports", "symbols", "declarations", "calls", "literals", "comments", "references", "annotations", "diagnostics", "duplicates"] as const;
export const FactKindSchema = z.enum(factKindValues);
export type FactKind = z.infer<typeof FactKindSchema>;

const SharedFactKind = {
  Text: "text",
  Type: "type",
  Unknown: "unknown",
} as const;

export const languageValues = ["typescript", "tsx", "javascript", "jsx", "svelte", "python", "json", "markdown", SharedFactKind.Text] as const;
export const LanguageSchema = z.enum(languageValues);
export type Language = z.infer<typeof LanguageSchema>;

export const DiagnosticSeverity = {
  Error: "error",
  Warning: "warning",
  Info: "info",
} as const;
export type DiagnosticSeverity = (typeof DiagnosticSeverity)[keyof typeof DiagnosticSeverity];
export const diagnosticSeverityValues = [DiagnosticSeverity.Error, DiagnosticSeverity.Warning, DiagnosticSeverity.Info] as const;
export const validatorSeverityValues = [DiagnosticSeverity.Error, DiagnosticSeverity.Warning] as const;

export const PositionSchema = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(1).optional(),
});
export type Position = z.infer<typeof PositionSchema>;

export const ImportFactSchema = PositionSchema.extend({
  source: z.string().min(1),
  specifiers: z.array(z.string()),
  kind: z.enum(["import", "export", "dynamic"]),
  resolution: z.enum(["relative", "alias", "workspace", "external", "unresolved"]),
  resolvedPath: z.string().min(1).optional(),
  fromPackage: z.string().min(1).optional(),
  toPackage: z.string().min(1).optional(),
});
export type ImportFact = z.infer<typeof ImportFactSchema>;

export const ExportFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  kind: z.enum(["function", "class", SharedFactKind.Type, "interface", "const", "let", "var", "enum", "default", "reexport", "star-reexport"]),
  source: z.string().min(1).optional(),
  importedName: z.string().min(1).optional(),
  typeOnly: z.boolean().optional(),
});
export type ExportFact = z.infer<typeof ExportFactSchema>;

export const SymbolFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  kind: z.enum(["function", "class", "method", "variable", SharedFactKind.Type, "interface", "enum", "property", SharedFactKind.Unknown]),
  exported: z.boolean().default(false),
  endLine: z.number().int().min(1).optional(),
  params: z.array(z.string()).optional(),
});
export type SymbolFact = z.infer<typeof SymbolFactSchema>;

export const EnumMemberFactSchema = z.object({
  line: z.number().int().min(1),
  name: z.string().min(1),
  value: z.string().optional(),
  valueKind: z.enum(["string", "number", SharedFactKind.Unknown]),
});
export type EnumMemberFact = z.infer<typeof EnumMemberFactSchema>;

export const ObjectPropertyFactSchema = z.object({
  line: z.number().int().min(1),
  key: z.string().min(1),
  quoted: z.boolean(),
  value: z.string(),
  valueKind: z.enum(["string", "number", "boolean", SharedFactKind.Unknown]),
});
export type ObjectPropertyFact = z.infer<typeof ObjectPropertyFactSchema>;

export const InitializerFactSchema = z.object({
  kind: z.enum(["object", "array", "literal", "call", SharedFactKind.Unknown]),
  asConst: z.boolean(),
  satisfies: z.string().min(1).optional(),
  properties: z.array(ObjectPropertyFactSchema).default([]),
});
export type InitializerFact = z.infer<typeof InitializerFactSchema>;

export const DeclarationFactSchema = z.object({
  line: z.number().int().min(1),
  endLine: z.number().int().min(1),
  name: z.string().min(1),
  kind: z.enum(["enum", "variable", SharedFactKind.Type, "function", "class", "interface"]),
  exported: z.boolean().default(false),
  text: z.string(),
  constEnum: z.boolean().optional(),
  members: z.array(EnumMemberFactSchema).default([]),
  declarationKind: z.enum(["const", "let", "var"]).optional(),
  initializer: InitializerFactSchema.optional(),
  async: z.boolean().optional(),
});
export type DeclarationFact = z.infer<typeof DeclarationFactSchema>;

export const CallFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  receiver: z.string().min(1).optional(),
  callee: z.string().min(1),
  tryDepth: z.number().int().min(0).default(0),
  argumentCalls: z.array(z.object({ callee: z.string().min(1), name: z.string().min(1), awaited: z.boolean() })).default([]),
});
export type CallFact = z.infer<typeof CallFactSchema>;

export const LiteralFactSchema = PositionSchema.extend({
  value: z.string(),
  valueKind: z.enum(["string", "number", "boolean"]),
  context: z.string().min(1),
  declarationSourceId: z.string().min(1).optional(),
});
export type LiteralFact = z.infer<typeof LiteralFactSchema>;

export const CommentFactSchema = PositionSchema.extend({
  text: z.string(),
  kind: z.enum(["line", "block"]),
});
export type CommentFact = z.infer<typeof CommentFactSchema>;

export const ReferenceFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  kind: z.enum(["identifier", "import", "export", "call", SharedFactKind.Type, SharedFactKind.Text, SharedFactKind.Unknown]),
  targetPath: z.string().min(1).optional(),
  targetName: z.string().min(1).optional(),
});
export type ReferenceFact = z.infer<typeof ReferenceFactSchema>;

export const AnnotationFactSchema = PositionSchema.extend({
  tag: z.string().min(1),
  value: z.string().default(""),
  raw: z.string().min(1),
  ownerName: z.string().min(1).optional(),
});
export type AnnotationFact = z.infer<typeof AnnotationFactSchema>;

export const DiagnosticFactSchema = PositionSchema.extend({
  source: z.string().min(1),
  code: z.string().min(1).optional(),
  message: z.string().min(1),
  severity: z.enum(diagnosticSeverityValues),
});
export type DiagnosticFact = z.infer<typeof DiagnosticFactSchema>;

export const DuplicateFactSchema = PositionSchema.extend({
  kind: z.enum(["literal", "object-shape", "schema-shape", "sql-fragment", "ast-block", SharedFactKind.Text]),
  key: z.string().min(1),
  value: z.string(),
  occurrences: z.number().int().min(2),
  files: z.array(z.string().min(1)).min(1),
});
export type DuplicateFact = z.infer<typeof DuplicateFactSchema>;

export const FactDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(diagnosticSeverityValues),
  position: PositionSchema.optional(),
});
export type FactDiagnostic = z.infer<typeof FactDiagnosticSchema>;

export const FileFactsSchema = z.object({
  path: z.string().min(1),
  contentHash: z.string().min(1),
  language: LanguageSchema,
  parser: z.string().min(1),
  parserVersion: z.string().min(1),
  imports: z.array(ImportFactSchema).default([]),
  exports: z.array(ExportFactSchema).default([]),
  symbols: z.array(SymbolFactSchema).default([]),
  declarations: z.array(DeclarationFactSchema).default([]),
  calls: z.array(CallFactSchema).default([]),
  literals: z.array(LiteralFactSchema).default([]),
  comments: z.array(CommentFactSchema).default([]),
  references: z.array(ReferenceFactSchema).default([]),
  annotations: z.array(AnnotationFactSchema).default([]),
  diagnosticFacts: z.array(DiagnosticFactSchema).default([]),
  duplicates: z.array(DuplicateFactSchema).default([]),
  diagnostics: z.array(FactDiagnosticSchema).default([]),
});
export type FileFacts = z.infer<typeof FileFactsSchema>;

export const WorkspaceNodeSchema = z.object({
  name: z.string().min(1),
  root: z.string(),
  kind: z.enum(["root", "app", "package", "workspace"]),
  dependencies: z.record(z.string(), z.string()).default({}),
});
export type WorkspaceNode = z.infer<typeof WorkspaceNodeSchema>;

export const ImportEdgeFactSchema = z.object({
  from: z.string().min(1),
  source: z.string().min(1),
  to: z.string().min(1).optional(),
  resolution: ImportFactSchema.shape.resolution,
  fromPackage: z.string().min(1).optional(),
  toPackage: z.string().min(1).optional(),
});
export type ImportEdgeFact = z.infer<typeof ImportEdgeFactSchema>;

export const RepoGraphSchema = z.object({
  rootDir: z.string().min(1),
  graphHash: z.string().min(1),
  files: z.array(z.string().min(1)),
  packages: z.array(WorkspaceNodeSchema).default([]),
  importEdges: z.array(ImportEdgeFactSchema).default([]),
});
export type RepoGraph = z.infer<typeof RepoGraphSchema>;

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

export const ExtractFactsRequestSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      contentHash: z.string().min(1),
      language: LanguageSchema,
      content: z.string().optional(),
    }),
  ),
  facts: z.array(FactKindSchema),
  parserVersion: z.string().min(1),
});
export type ExtractFactsRequest = z.infer<typeof ExtractFactsRequestSchema>;

export const ExtractFactsResultSchema = z.object({
  files: z.array(FileFactsSchema),
  diagnostics: z.array(FactDiagnosticSchema).default([]),
});
export type ExtractFactsResult = z.infer<typeof ExtractFactsResultSchema>;

export const BuildRepoGraphRequestSchema = z.object({
  facts: z.array(FileFactsSchema),
  packageManifests: z.array(z.string().min(1)).default([]),
});
export type BuildRepoGraphRequest = z.infer<typeof BuildRepoGraphRequestSchema>;

export const BuildRepoGraphResultSchema = z.object({
  graph: RepoGraphSchema,
});
export type BuildRepoGraphResult = z.infer<typeof BuildRepoGraphResultSchema>;

export const IndexCodeGraphRequestSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      contentHash: z.string().min(1),
      language: LanguageSchema,
      content: z.string().optional(),
    }),
  ),
  deletedFiles: z.array(z.string().min(1)).default([]),
  parserVersion: z.string().default(""),
  extractorVersion: z.string().default(""),
});
export type IndexCodeGraphRequest = z.input<typeof IndexCodeGraphRequestSchema>;

export const IndexCodeGraphResultSchema = z.object({
  indexed: z.array(
    z.object({
      path: z.string().min(1),
      nodes: z.number().int().min(0),
      unresolved: z.number().int().min(0),
      supported: z.boolean(),
    }),
  ),
  deleted: z.array(z.string().min(1)).default([]),
  diagnostics: z
    .array(
      z.object({
        path: z.string().min(1),
        code: z.string().min(1),
        message: z.string().min(1),
        severity: z.string().min(1),
      }),
    )
    .default([]),
  parserVersion: z.string().min(1),
  extractorVersion: z.string().min(1),
});
export type IndexCodeGraphResult = z.infer<typeof IndexCodeGraphResultSchema>;

export const SearchSymbolsRequestSchema = z.object({
  query: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
export type SearchSymbolsRequest = z.input<typeof SearchSymbolsRequestSchema>;

export const codeSymbolKindValues = ["function", "class", "variable", "type", "interface", "enum", "export-default"] as const;
export const CodeSymbolKindSchema = z.enum(codeSymbolKindValues);
export type CodeSymbolKind = z.infer<typeof CodeSymbolKindSchema>;

export const SymbolRangePositionSchema = z.object({
  line: z.number().int().min(1),
  column: z.number().int().min(1),
  byte: z.number().int().min(0),
});
export const SymbolRangeSchema = z.object({
  start: SymbolRangePositionSchema,
  end: SymbolRangePositionSchema,
});
export const CodeSymbolSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  language: z.string().min(1),
  kind: CodeSymbolKindSchema,
  name: z.string().min(1),
  qualifiedName: z.string().min(1),
  exported: z.boolean(),
  signature: z.string().nullable().optional(),
  range: SymbolRangeSchema,
  score: z.number().nullable().optional(),
});
export type CodeSymbol = z.infer<typeof CodeSymbolSchema>;

export const SearchSymbolsResultSchema = z.object({
  symbols: z.array(CodeSymbolSchema),
});
export type SearchSymbolsResult = z.infer<typeof SearchSymbolsResultSchema>;

export const SearchReferencesRequestSchema = z.object({
  query: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  source: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type SearchReferencesRequest = z.input<typeof SearchReferencesRequestSchema>;

export const CodeReferenceSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  language: z.string().min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  source: z.string().nullable().optional(),
  range: SymbolRangeSchema,
  provenance: z.string().min(1),
  confidence: z.string().min(1),
});
export type CodeReference = z.infer<typeof CodeReferenceSchema>;

export const SearchReferencesResultSchema = z.object({
  references: z.array(CodeReferenceSchema),
});
export type SearchReferencesResult = z.infer<typeof SearchReferencesResultSchema>;

export const SearchGraphEdgesRequestSchema = z.object({
  query: z.string().min(1).optional(),
  symbolId: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
  kind: z.string().min(1).optional(),
  direction: z.enum(["incoming", "outgoing", "both"]).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});
export type SearchGraphEdgesRequest = z.input<typeof SearchGraphEdgesRequestSchema>;

export const CodeGraphEdgeSchema = z.object({
  id: z.string().min(1),
  kind: z.string().min(1),
  provenance: z.string().min(1),
  confidence: z.string().min(1),
  path: z.string().min(1),
  range: z.object({
    start: SymbolRangePositionSchema,
  }),
  source: CodeSymbolSchema,
  target: CodeSymbolSchema,
});
export type CodeGraphEdge = z.infer<typeof CodeGraphEdgeSchema>;

export const SearchGraphEdgesResultSchema = z.object({
  edges: z.array(CodeGraphEdgeSchema),
});
export type SearchGraphEdgesResult = z.infer<typeof SearchGraphEdgesResultSchema>;

export const semanticIndexStatusValues = ["disabled", "indexing", "ready", "stale", "failed"] as const;
export const SemanticIndexStatusValueSchema = z.enum(semanticIndexStatusValues);
export type SemanticIndexStatusValue = z.infer<typeof SemanticIndexStatusValueSchema>;

export const semanticChunkKindValues = ["file", "section", "symbol", "text"] as const;
export const SemanticChunkKindSchema = z.enum(semanticChunkKindValues);
export type SemanticChunkKind = z.infer<typeof SemanticChunkKindSchema>;

export const semanticDistanceValues = ["cosine"] as const;
export const SemanticDistanceSchema = z.enum(semanticDistanceValues);
export type SemanticDistance = z.infer<typeof SemanticDistanceSchema>;

export const SemanticEmbeddingProviderSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["local", "native", "remote"]).default("local"),
  displayName: z.string().min(1).optional(),
  modelId: z.string().min(1),
  modelDigest: z.string().min(1).optional(),
  dimensions: z.number().int().min(1),
  distance: SemanticDistanceSchema.default("cosine"),
  configHash: z.string().min(1),
});
export type SemanticEmbeddingProvider = z.infer<typeof SemanticEmbeddingProviderSchema>;

export const semanticEmbeddingTaskValues = ["document", "query"] as const;
export const SemanticEmbeddingTaskSchema = z.enum(semanticEmbeddingTaskValues);
export type SemanticEmbeddingTask = z.infer<typeof SemanticEmbeddingTaskSchema>;

export const EmbedSemanticTextsRequestSchema = z.object({
  modelId: z.string().min(1),
  task: SemanticEmbeddingTaskSchema.default("document"),
  texts: z.array(z.string()).min(1),
  nGpuLayers: z.number().int().min(0).optional(),
  nThreads: z.number().int().min(1).optional(),
  nCtx: z.number().int().min(1).optional(),
  showDownloadProgress: z.boolean().default(true),
});
export type EmbedSemanticTextsRequest = z.input<typeof EmbedSemanticTextsRequestSchema>;

export const EmbedSemanticTextsResultSchema = z.object({
  modelId: z.string().min(1),
  dimensions: z.number().int().min(1),
  vectors: z.array(z.array(z.number()).min(1)).min(1),
});
export type EmbedSemanticTextsResult = z.infer<typeof EmbedSemanticTextsResultSchema>;

export const GenerateTextRequestSchema = z.object({
  modelId: z.string().min(1),
  prompt: z.string().min(1),
  maxTokens: z.number().int().min(1).max(4096).optional(),
  temperature: z.number().min(0).max(2).optional(),
  topP: z.number().min(0).max(1).optional(),
  seed: z.number().int().min(0).optional(),
  nGpuLayers: z.number().int().min(0).optional(),
  nThreads: z.number().int().min(1).optional(),
  nCtx: z.number().int().min(1).optional(),
  showDownloadProgress: z.boolean().default(true),
});
export type GenerateTextRequest = z.input<typeof GenerateTextRequestSchema>;

export const GenerateTextResultSchema = z.object({
  modelId: z.string().min(1),
  text: z.string(),
});
export type GenerateTextResult = z.infer<typeof GenerateTextResultSchema>;

export const SemanticIndexDiagnosticSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  severity: z.enum(diagnosticSeverityValues).default(DiagnosticSeverity.Warning),
  path: z.string().min(1).optional(),
});
export type SemanticIndexDiagnostic = z.infer<typeof SemanticIndexDiagnosticSchema>;

export const SemanticIndexSnapshotSchema = z.object({
  id: z.string().min(1),
  version: z.string().min(1),
  status: SemanticIndexStatusValueSchema,
  provider: SemanticEmbeddingProviderSchema,
  chunkerVersion: z.string().min(1),
  producerVersion: z.string().min(1),
  sourceInventoryHash: z.string().min(1),
  chunkTreeHash: z.string().min(1),
  identityHash: z.string().min(1),
  chunkCount: z.number().int().min(0),
  vectorCount: z.number().int().min(0),
  staleChunkCount: z.number().int().min(0),
  embeddingStats: z.object({
    totalChunks: z.number().int().min(0),
    embeddedChunks: z.number().int().min(0),
    reusedChunks: z.number().int().min(0),
  }).optional(),
  indexedAt: z.string().datetime(),
  diagnostics: z.array(SemanticIndexDiagnosticSchema).default([]),
});
export type SemanticIndexSnapshot = z.infer<typeof SemanticIndexSnapshotSchema>;

export const SemanticChunkMetadataSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  contentHash: z.string().min(1),
  chunkHash: z.string().min(1),
  embeddingHash: z.string().min(1),
  kind: SemanticChunkKindSchema,
  language: z.string().min(1),
  ordinal: z.number().int().min(0),
  range: SymbolRangeSchema,
  heading: z.string().min(1).optional(),
  symbol: z.string().min(1).optional(),
  tokenEstimate: z.number().int().min(0),
  preview: z.string(),
});
export type SemanticChunkMetadata = z.infer<typeof SemanticChunkMetadataSchema>;

export const SemanticChunkEmbeddingSchema = z.object({
  metadata: SemanticChunkMetadataSchema,
  text: z.string(),
  vector: z.array(z.number()),
});
export type SemanticChunkEmbedding = z.infer<typeof SemanticChunkEmbeddingSchema>;

export const WriteSemanticIndexRequestSchema = z.object({
  index: SemanticIndexSnapshotSchema,
  chunks: z.array(SemanticChunkEmbeddingSchema),
});
export type WriteSemanticIndexRequest = z.infer<typeof WriteSemanticIndexRequestSchema>;

export const ReadSemanticIndexStatusRequestSchema = z.object({
  indexId: z.string().min(1).default("project"),
});
export type ReadSemanticIndexStatusRequest = z.input<typeof ReadSemanticIndexStatusRequestSchema>;

export const ReadSemanticIndexStatusResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
});
export type ReadSemanticIndexStatusResult = z.infer<typeof ReadSemanticIndexStatusResultSchema>;

export const SearchSemanticIndexRequestSchema = z.object({
  indexId: z.string().min(1).default("project"),
  query: z.string().min(1).optional(),
  vector: z.array(z.number()).min(1).optional(),
  paths: z.array(z.string().min(1)).default([]),
  limit: z.number().int().min(1).max(100).default(20),
});
export type SearchSemanticIndexRequest = z.input<typeof SearchSemanticIndexRequestSchema>;

export const SemanticSearchResultSchema = z.object({
  chunk: SemanticChunkMetadataSchema,
  score: z.number(),
  scores: z.object({
    vector: z.number().optional(),
    lexical: z.number().optional(),
    combined: z.number(),
  }).optional(),
});
export type SemanticSearchResult = z.infer<typeof SemanticSearchResultSchema>;

export const SearchSemanticIndexResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  results: z.array(SemanticSearchResultSchema),
});
export type SearchSemanticIndexResult = z.infer<typeof SearchSemanticIndexResultSchema>;

export const ListSemanticChunksRequestSchema = z.object({
  indexId: z.string().min(1).default("project"),
  paths: z.array(z.string().min(1)).default([]),
  limit: z.number().int().min(1).max(500).default(100),
  offset: z.number().int().min(0).default(0),
});
export type ListSemanticChunksRequest = z.input<typeof ListSemanticChunksRequestSchema>;

export const ListSemanticChunksResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  chunks: z.array(SemanticChunkMetadataSchema),
});
export type ListSemanticChunksResult = z.infer<typeof ListSemanticChunksResultSchema>;

export const ProjectContextLinkSchema = z.object({
  kind: z.enum(["area", "spec", "change", "convention", "impact-surface", "task", "check", "finding", "file", "symbol", "doc"]),
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});
export type ProjectContextLink = z.infer<typeof ProjectContextLinkSchema>;

export const ProjectContextEvidenceSchema = z.object({
  chunk: SemanticChunkMetadataSchema,
  file: z.string().min(1),
  line: z.number().int().min(1),
  preview: z.string(),
  score: z.number().optional(),
  scores: SemanticSearchResultSchema.shape.scores.optional(),
  definitions: z.array(ProjectContextLinkSchema).default([]),
  surfaces: z.array(ProjectContextLinkSchema).default([]),
  checks: z.array(ProjectContextLinkSchema).default([]),
  findings: z.array(ProjectContextLinkSchema).default([]),
});
export type ProjectContextEvidence = z.infer<typeof ProjectContextEvidenceSchema>;

export const ProjectContextSearchResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  query: z.string().min(1),
  results: z.array(ProjectContextEvidenceSchema),
});
export type ProjectContextSearchResult = z.infer<typeof ProjectContextSearchResultSchema>;

export const ProjectContextAskResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  question: z.string().min(1),
  answer: z.string(),
  deterministic: z.literal(true),
  evidence: z.array(ProjectContextEvidenceSchema),
  suggestions: z.array(z.string()).default([]),
  warnings: z.array(z.string()).default([]),
});
export type ProjectContextAskResult = z.infer<typeof ProjectContextAskResultSchema>;

export const ProjectContextCoverageFileSchema = z.object({
  file: z.string().min(1),
  areas: z.array(ProjectContextLinkSchema).default([]),
  specs: z.array(ProjectContextLinkSchema).default([]),
  changes: z.array(ProjectContextLinkSchema).default([]),
  conventions: z.array(ProjectContextLinkSchema).default([]),
  surfaces: z.array(ProjectContextLinkSchema).default([]),
  indexedChunks: z.number().int().min(0),
});
export type ProjectContextCoverageFile = z.infer<typeof ProjectContextCoverageFileSchema>;

export const ProjectContextCoverageResultSchema = z.object({
  index: SemanticIndexSnapshotSchema.nullable(),
  totals: z.object({
    files: z.number().int().min(0),
    indexedFiles: z.number().int().min(0),
    governedFiles: z.number().int().min(0),
    ungovernedFiles: z.number().int().min(0),
    chunks: z.number().int().min(0),
    staleChunks: z.number().int().min(0),
  }),
  files: z.array(ProjectContextCoverageFileSchema),
  gaps: z.array(z.object({
    kind: z.enum(["ungoverned-file", "unindexed-file", "stale-index"]),
    file: z.string().min(1).optional(),
    message: z.string().min(1),
  })),
});
export type ProjectContextCoverageResult = z.infer<typeof ProjectContextCoverageResultSchema>;

export const ProjectContextBacklinksResultSchema = z.object({
  query: z.string().min(1),
  links: z.array(ProjectContextLinkSchema),
  files: z.array(ProjectContextCoverageFileSchema),
});
export type ProjectContextBacklinksResult = z.infer<typeof ProjectContextBacklinksResultSchema>;

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
  status: z.enum(["ready", "indexing", "stale", "failed"]),
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
  health: RuntimeHealthSchema,
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
