import { z } from "zod";
import { OpenCanonDiagnosticSchema } from "./errors.ts";

export const validatorScopeValues = ["file", "folder", "import-edge", "package", "project"] as const;
export const ValidatorScopeSchema = z.enum(validatorScopeValues);
export type ValidatorScope = z.infer<typeof ValidatorScopeSchema>;

export const factKindValues = ["imports", "exports", "symbols", "calls", "literals", "comments", "references", "annotations", "diagnostics", "duplicates"] as const;
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
  kind: z.enum(["function", "class", SharedFactKind.Type, "interface", "const", "let", "var", "enum", "default", SharedFactKind.Unknown]),
});
export type ExportFact = z.infer<typeof ExportFactSchema>;

export const SymbolFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  kind: z.enum(["function", "class", "method", "variable", SharedFactKind.Type, "interface", "enum", "property", SharedFactKind.Unknown]),
  exported: z.boolean().default(false),
  endLine: z.number().int().min(1).optional(),
});
export type SymbolFact = z.infer<typeof SymbolFactSchema>;

export const CallFactSchema = PositionSchema.extend({
  name: z.string().min(1),
  receiver: z.string().min(1).optional(),
  callee: z.string().min(1),
});
export type CallFact = z.infer<typeof CallFactSchema>;

export const LiteralFactSchema = PositionSchema.extend({
  value: z.string(),
  valueKind: z.enum(["string", "number", "boolean"]),
  context: z.string().min(1),
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
  applies: z.array(z.string().min(1)).default([]),
  facts: z.array(FactKindSchema).default([]),
  decisionIds: z.array(z.string().min(1)).default([]),
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
  decisionIds: z.array(z.string().min(1)).default([]),
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

export const DecisionSchema = z.object({
  id: z.string().min(1),
  date: z.string().min(1),
  status: z.enum(["current", "proposed", "replaced"]),
  title: z.string().min(1),
  topics: z.array(z.string().min(1)).min(1),
  applies: z.array(z.string().min(1)).min(1),
  summary: z.string().min(1),
  required: z.array(z.string().min(1)).default([]),
  replaced: z.array(z.string().min(1)).default([]),
  agentPolicy: z.array(z.string().min(1)).default([]),
  exceptions: z.array(z.string().min(1)).default([]),
  validatorIds: z.array(z.string().min(1)).default([]),
  rationale: z.array(z.string().min(1)).default([]),
  examples: z.array(z.string().min(1)).default([]),
  docs: z.array(z.string().min(1)).default([]),
});
export type CanonDecision = z.infer<typeof DecisionSchema>;

export const ChangePolicySchema = z.object({
  requiresTests: z.array(z.string().min(1)).default([]),
  requiresDocs: z.array(z.string().min(1)).default([]),
  requiresDecision: z.boolean().default(false),
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
    requiresDecision: false,
    reviewers: [],
  }),
  docs: z.array(z.string().min(1)).default([]),
  decisionIds: z.array(z.string().min(1)).default([]),
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
  decisionIds: z.array(z.string().min(1)).default([]),
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
export type ExternalToolMissingSeverity = (typeof externalToolMissingSeverityValues)[number];
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

export const CanonBundleDocsSchema = z.object({
  path: z.string().min(1),
  heading: z.string().min(1),
  body: z.string().min(1),
});
export type CanonBundleDocs = z.infer<typeof CanonBundleDocsSchema>;

export const CanonBundleFileSchema = z.object({
  path: z.string().min(1),
  content: z.string(),
  executable: z.boolean().default(false),
});
export type CanonBundleFile = z.infer<typeof CanonBundleFileSchema>;

export const CanonBundleOptionValueSchema = z.union([z.string(), z.array(z.string()), z.boolean(), z.number()]);
export type CanonBundleOptionValue = z.infer<typeof CanonBundleOptionValueSchema>;

export const CanonBundleOptionType = {
  String: "string",
  StringArray: "string[]",
  Boolean: "boolean",
  Number: "number",
  Enum: "enum",
} as const;
export type CanonBundleOptionType = (typeof CanonBundleOptionType)[keyof typeof CanonBundleOptionType];
export const canonBundleOptionTypeValues = [
  CanonBundleOptionType.String,
  CanonBundleOptionType.StringArray,
  CanonBundleOptionType.Boolean,
  CanonBundleOptionType.Number,
  CanonBundleOptionType.Enum,
] as const;

export const CanonBundleOptionSchema = z
  .object({
    type: z.enum(canonBundleOptionTypeValues),
    description: z.string().min(1).optional(),
    default: CanonBundleOptionValueSchema.optional(),
    values: z.array(z.string().min(1)).optional(),
    required: z.boolean().default(false),
  })
  .superRefine((option, ctx) => {
    if (option.type === CanonBundleOptionType.Enum && (!option.values || option.values.length === 0)) {
      ctx.addIssue({ code: "custom", message: "Enum bundle options must declare values.", path: ["values"] });
    }
    if (option.default === undefined) return;
    const defaultValue = option.default;
    const defaultMatchesType =
      (option.type === CanonBundleOptionType.String && typeof defaultValue === "string") ||
      (option.type === CanonBundleOptionType.StringArray && Array.isArray(defaultValue)) ||
      (option.type === CanonBundleOptionType.Boolean && typeof defaultValue === "boolean") ||
      (option.type === CanonBundleOptionType.Number && typeof defaultValue === "number") ||
      (option.type === CanonBundleOptionType.Enum && typeof defaultValue === "string" && (option.values ?? []).includes(defaultValue));
    if (!defaultMatchesType) ctx.addIssue({ code: "custom", message: "Bundle option default must match its type.", path: ["default"] });
  });
export type CanonBundleOption = z.infer<typeof CanonBundleOptionSchema>;

export const CanonBundleSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  topics: z.array(z.string().min(1)).min(1),
  validators: z.array(z.string().min(1)).default([]),
  description: z.string().min(1).optional(),
  options: z.record(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/), CanonBundleOptionSchema).default({}),
  decisions: z.array(DecisionSchema).default([]),
  docs: z.array(CanonBundleDocsSchema).default([]),
  files: z.array(CanonBundleFileSchema).default([]),
  impactSurfaces: z.array(ImpactSurfaceSchema).default([]),
  externalTools: z.record(z.string(), ExternalToolSchema).default({}),
});
export type CanonBundle = z.infer<typeof CanonBundleSchema>;

export const DocSnippetSchema = z.object({
  source: z.string().min(1),
  path: z.string().min(1),
  slug: z.string().min(1),
  heading: z.string().min(1),
  level: z.number().int().min(1).max(6),
  startLine: z.number().int().min(1),
  endLine: z.number().int().min(1),
  body: z.string(),
  decisionIds: z.array(z.string().min(1)).default([]),
  contentHash: z.string().min(1),
});
export type CanonDocSnippet = z.infer<typeof DocSnippetSchema>;

export const CanonEventSchema = z.object({
  id: z.string().min(1),
  type: z.enum(["created", "updated", "superseded", "enforced", "violated", "fixed", "recommended", "indexed"]),
  timestamp: z.string().datetime(),
  actor: z.string().min(1).optional(),
  commit: z.string().min(1).optional(),
  files: z.array(z.string().min(1)).default([]),
  decisionIds: z.array(z.string().min(1)).default([]),
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
  decisionsPath: z.string().min(1),
  validatorsPath: z.string().min(1),
  fixturesDir: z.string().min(1),
  impactSurfacesPath: z.string().min(1).default("docs/opencanon/impact-surfaces.json"),
  proposedImpactNotesPath: z.string().min(1).default("docs/opencanon/proposed-impact-notes.json"),
  baselinePath: z.string().min(1).default(".opencanon/baseline.json"),
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

export const WatcherStatusSchema = z.object({
  running: z.boolean(),
  bufferedEvents: z.number().int().min(0),
  stale: z.boolean(),
  reason: z.string().min(1).optional(),
});
export type WatcherStatus = z.infer<typeof WatcherStatusSchema>;

export const EngineProjectStatusSchema = z.object({
  rootDir: z.string().min(1),
  statePath: z.string().min(1),
  schemaVersion: z.number().int().min(1),
  migrationsApplied: z.array(z.number().int().min(1)),
  watcher: WatcherStatusSchema.default({ running: false, bufferedEvents: 0, stale: false }),
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

export const ExtractFactsRequestSchema = z.object({
  files: z.array(
    z.object({
      path: z.string().min(1),
      contentHash: z.string().min(1),
      language: LanguageSchema,
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

export const DaemonSuccessSchema = z.object({
  ok: z.literal(true),
  data: z.unknown(),
});
export const DaemonFailureSchema = z.object({
  ok: z.literal(false),
  diagnostics: z.array(OpenCanonDiagnosticSchema).min(1),
});
export const DaemonResponseSchema = z.union([DaemonSuccessSchema, DaemonFailureSchema]);
export type DaemonResponse = z.infer<typeof DaemonResponseSchema>;

export const DaemonHealthSchema = z.object({
  status: z.enum(["ready", "indexing", "stale", "failed"]),
  schemaVersion: z.number().int().min(1),
  engine: EngineVersionSchema,
  watcher: WatcherStatusSchema.default({ running: false, bufferedEvents: 0, stale: false }),
  startedAt: z.string().datetime(),
});
export type DaemonHealth = z.infer<typeof DaemonHealthSchema>;

export const DaemonStateSchema = z.object({
  health: DaemonHealthSchema,
  files: z.number().int().min(0),
  findings: z.number().int().min(0),
  staleFiles: z.number().int().min(0),
  cacheHits: z.number().int().min(0),
  cacheMisses: z.number().int().min(0),
});
export type DaemonState = z.infer<typeof DaemonStateSchema>;

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
