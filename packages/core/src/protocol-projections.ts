import { z } from "zod";
import {
  ChangeCheckRunEventSchema,
  ChangeCheckRunSchema,
  StartChangeCheckRunsResponseSchema,
} from "./contracts-change-runs.ts";
import { CodeGraphEdgeSchema, CodeReferenceSchema, CodeSymbolSchema } from "./contracts-code-graph.ts";
import {
  CanonEventSchema,
  CanonFindingSchema,
  DocSnippetSchema,
  ImpactSurfaceSchema,
  ValidatorContractSchema,
} from "./contracts-governance.ts";
import {
  RuntimeHealthSchema,
  RuntimeLiveStateSchema,
  RuntimeProjectSummarySchema,
  RuntimeValidatorCatalogSchema,
} from "./contracts-runtime.ts";
import {
  ListSemanticChunksResultSchema,
  ProjectContextAskResultSchema,
  ProjectContextBacklinksResultSchema,
  ProjectContextCoverageResultSchema,
  ProjectContextSearchResultSchema,
  ReadSemanticIndexStatusResultSchema,
  SemanticIndexSnapshotSchema,
} from "./contracts-semantic.ts";
import { OpenCanonDiagnosticSchema } from "./errors.ts";
import { ProjectProtocolEventSchema, ProtocolEventReplaySchema } from "./protocol.ts";
import { TaskLeaseSummarySchema, WorktreeOverviewSchema } from "./worktree.ts";

const NonEmptyStringSchema = z.string().min(1);
const JsonObjectSchema = z.record(z.string(), z.json());
const StringArraySchema = z.array(NonEmptyStringSchema);
const CheckKindSchema = z.enum(["command", "doctor", "validator", "test"]);
const ChangeKindSchema = z.enum(["feature", "fix", "refactor", "docs", "chore", "research"]);
const RenderKindSchema = z.enum(["generated", "none"]);

const PublicHealthSchema = z.object({ status: z.literal("ok") }).strict();
const HealthOutputSchema = z.union([PublicHealthSchema, RuntimeHealthSchema]);

const DefinitionTargetBaseShape = {
  id: NonEmptyStringSchema.optional(),
  label: NonEmptyStringSchema.optional(),
  description: NonEmptyStringSchema.optional(),
  adapter: NonEmptyStringSchema.optional(),
};

const DefinitionTargetSchema = z.discriminatedUnion("kind", [
  z.object({ ...DefinitionTargetBaseShape, kind: z.literal("file"), path: NonEmptyStringSchema }).strict(),
  z.object({ ...DefinitionTargetBaseShape, kind: z.literal("package"), name: NonEmptyStringSchema }).strict(),
  z.object({ ...DefinitionTargetBaseShape, kind: z.literal("endpoint"), path: NonEmptyStringSchema, protocol: NonEmptyStringSchema.optional() }).strict(),
  z.object({ ...DefinitionTargetBaseShape, kind: z.literal("command"), name: NonEmptyStringSchema }).strict(),
  z.object({ ...DefinitionTargetBaseShape, kind: z.literal("doc"), path: NonEmptyStringSchema }).strict(),
  z.object({ ...DefinitionTargetBaseShape, kind: z.literal("resource"), name: NonEmptyStringSchema, type: NonEmptyStringSchema.optional() }).strict(),
]);

const ChangeUpdatesSchema = z.object({
  areas: StringArraySchema,
  specs: StringArraySchema,
  conventions: StringArraySchema,
  surfaces: StringArraySchema,
  docs: StringArraySchema,
}).strict();

const ChangeEventSummarySchema = z.object({
  id: NonEmptyStringSchema,
  type: CanonEventSchema.shape.type,
  timestamp: z.string().datetime(),
  summary: NonEmptyStringSchema,
  actor: NonEmptyStringSchema.optional(),
}).strict();

const ChangeCheckStateSchema = z.object({
  id: NonEmptyStringSchema,
  kind: CheckKindSchema,
  status: z.enum(["unknown", "running", "passed", "failed"]),
  latestEvent: ChangeEventSummarySchema.optional(),
}).strict();

const SnapshotChangeTaskSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  detail: NonEmptyStringSchema.optional(),
  files: StringArraySchema,
  surfaces: StringArraySchema,
  checks: StringArraySchema,
  dependsOn: StringArraySchema,
  blockedBy: StringArraySchema,
  updates: ChangeUpdatesSchema,
  status: z.enum(["planned", "claimed", "running", "review", "blocked", "ready", "closed"]),
  ready: z.boolean(),
  blockedReasons: z.array(z.string()),
  lease: TaskLeaseSummarySchema.optional(),
  checkStates: z.array(ChangeCheckStateSchema),
  latestEvent: ChangeEventSummarySchema.optional(),
}).strict();

const SnapshotAreaSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  summary: z.string(),
  surfaces: StringArraySchema,
  owns: z.array(DefinitionTargetSchema),
  storyCount: z.number().int().min(0),
  behaviorCount: z.number().int().min(0),
  checks: z.array(z.object({ id: NonEmptyStringSchema, kind: CheckKindSchema }).strict()),
  dependsOn: StringArraySchema,
  docs: StringArraySchema,
  render: RenderKindSchema,
  source: NonEmptyStringSchema,
}).strict();

const SnapshotChangeSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  kind: ChangeKindSchema,
  summary: z.string(),
  intent: z.object({ problem: NonEmptyStringSchema, outcome: NonEmptyStringSchema, why: NonEmptyStringSchema.optional() }).strict(),
  updates: ChangeUpdatesSchema,
  scope: z.array(DefinitionTargetSchema),
  planCount: z.number().int().min(0),
  taskCount: z.number().int().min(0),
  readyTaskCount: z.number().int().min(0),
  blockedTaskCount: z.number().int().min(0),
  tasks: z.array(SnapshotChangeTaskSchema),
  checks: z.array(z.object({ id: NonEmptyStringSchema, kind: CheckKindSchema }).strict()),
  dependsOn: StringArraySchema,
  blockedBy: StringArraySchema,
  docs: StringArraySchema,
  render: RenderKindSchema,
  source: NonEmptyStringSchema,
  boardColumn: z.enum(["planned", "running", "review", "blocked", "ready", "closed"]),
  lastEvent: z.object({ type: CanonEventSchema.shape.type, timestamp: z.string().datetime(), summary: NonEmptyStringSchema }).strict().optional(),
}).strict();

const SnapshotSpecSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  summary: z.string(),
  surfaces: StringArraySchema,
  areas: StringArraySchema,
  scope: z.array(DefinitionTargetSchema),
  ruleCount: z.number().int().min(0),
  scenarioCount: z.number().int().min(0),
  checks: z.array(z.object({ id: NonEmptyStringSchema, kind: CheckKindSchema }).strict()),
  dependsOn: StringArraySchema,
  governedBy: StringArraySchema,
  docs: StringArraySchema,
  render: RenderKindSchema,
  source: NonEmptyStringSchema,
}).strict();

const SnapshotConventionSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  topics: StringArraySchema,
  applies: StringArraySchema,
  rule: NonEmptyStringSchema,
  why: NonEmptyStringSchema.optional(),
  related: StringArraySchema,
  impactSurfaces: StringArraySchema,
  docs: StringArraySchema,
  runtime: z.enum(["none", "validator", "gate", "test"]),
  render: RenderKindSchema,
  source: NonEmptyStringSchema,
}).strict();

const SnapshotValidatorSchema = z.object({
  id: NonEmptyStringSchema,
  topics: StringArraySchema,
  applies: StringArraySchema,
  severity: z.enum(["error", "warning"]),
  scope: z.enum(["file", "folder", "import-edge", "package", "project"]),
  domain: z.enum(["file", "import-edge", "impact-surface", "definition", "project", "custom"]),
  facts: ValidatorContractSchema.shape.facts,
  conventionIds: StringArraySchema,
  docs: StringArraySchema,
  summary: NonEmptyStringSchema.optional(),
}).strict();

const RelatedCanonSchema = z.object({
  root: NonEmptyStringSchema,
  query: z.object({
    files: StringArraySchema,
    topics: StringArraySchema,
    conventions: StringArraySchema,
    validators: StringArraySchema,
    findings: StringArraySchema,
  }).strict(),
  matchedTopics: StringArraySchema,
  docs: z.array(DocSnippetSchema),
  areas: z.array(SnapshotAreaSchema),
  specs: z.array(SnapshotSpecSchema),
  changes: z.array(SnapshotChangeSchema),
  conventions: z.array(SnapshotConventionSchema),
  validators: z.array(SnapshotValidatorSchema),
  findings: z.array(CanonFindingSchema),
  impactSurfaces: z.array(ImpactSurfaceSchema),
}).strict();

const ChangeReadyWorkItemSchema = z.object({
  kind: z.enum(["change", "task"]),
  changeId: NonEmptyStringSchema,
  changeTitle: NonEmptyStringSchema,
  taskId: NonEmptyStringSchema.optional(),
  taskTitle: NonEmptyStringSchema.optional(),
  checks: StringArraySchema,
  files: StringArraySchema,
  surfaces: StringArraySchema,
  updates: ChangeUpdatesSchema,
  suggestedCommands: StringArraySchema,
  reason: NonEmptyStringSchema,
}).strict();

const ChangeWorkQueueSchema = z.object({
  ready: z.array(ChangeReadyWorkItemSchema),
  blocked: z.array(ChangeReadyWorkItemSchema.extend({ blockedReasons: z.array(z.string()) }).strict()),
}).strict();

const ChangeCheckRunSnapshotSchema = z.object({
  run: ChangeCheckRunSchema,
  latestSequence: z.number().int().min(0),
  events: z.array(ChangeCheckRunEventSchema),
}).strict();

const ChangeCheckRunsReadSchema = z.union([
  ChangeCheckRunSnapshotSchema,
  z.object({ runs: z.array(ChangeCheckRunSchema) }).strict(),
]);

const ActivityRecordResultSchema = z.object({
  event: CanonEventSchema,
  changes: z.array(SnapshotChangeSchema),
}).strict();

const CodeSymbolsSchema = z.union([
  z.object({ sourceFiles: z.number().int().min(0), symbols: z.array(CodeSymbolSchema) }).strict(),
  z.object({ sourceFiles: z.number().int().min(0), references: z.array(CodeReferenceSchema) }).strict(),
]);

const CodeGraphSchema = z.object({
  sourceFiles: z.number().int().min(0),
  edges: z.array(CodeGraphEdgeSchema),
}).strict();

const ContextPacketSchema = z.object({
  schema: z.literal("opencanon.context-packet.v1"),
  mode: NonEmptyStringSchema,
  generatedAt: z.string().datetime(),
  rootDir: NonEmptyStringSchema,
  filters: z.object({ files: StringArraySchema, changeIds: StringArraySchema, limit: z.number().int().positive() }).strict(),
  xml: z.string(),
  facts: z.object({
    files: z.number().int().min(0),
    conventions: z.number().int().min(0),
    areas: z.number().int().min(0),
    specs: z.number().int().min(0),
    changes: z.number().int().min(0),
    checks: z.number().int().min(0),
    readyTasks: z.number().int().min(0),
    findings: z.number().int().min(0),
    doctorStatus: NonEmptyStringSchema,
    semanticIndexStatus: NonEmptyStringSchema,
    semanticIndexEmbeddedChunks: z.number().int().min(0),
    semanticIndexReusedChunks: z.number().int().min(0),
  }).strict(),
}).strict();

const DefinitionHistoryTargetSchema = z.object({
  kind: z.enum(["convention", "area", "spec", "change"]),
  requestedId: NonEmptyStringSchema,
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  definitionFiles: StringArraySchema,
  docFiles: StringArraySchema,
  files: StringArraySchema,
}).strict();

const HistoryCommitSchema = z.object({
  hash: NonEmptyStringSchema,
  fullHash: NonEmptyStringSchema,
  timestamp: z.number().int().min(0),
  date: NonEmptyStringSchema,
  author: NonEmptyStringSchema,
  subject: z.string(),
}).strict();

const CanonHistorySchema = z.object({
  target: DefinitionHistoryTargetSchema,
  gitRoot: NonEmptyStringSchema.nullable(),
  args: z.array(z.string()),
  diagnostics: z.array(z.string()),
  commits: z.array(HistoryCommitSchema),
}).strict();

const GitCommitSchema = z.object({
  hash: NonEmptyStringSchema,
  fullHash: NonEmptyStringSchema,
  date: NonEmptyStringSchema,
  author: NonEmptyStringSchema,
  subject: z.string(),
}).strict();

const GitHistorySchema = z.object({
  gitRoot: NonEmptyStringSchema.nullable(),
  histories: z.array(z.object({ file: NonEmptyStringSchema, commits: z.array(GitCommitSchema), diagnostics: z.array(z.string()) }).strict()),
  diagnostics: z.array(z.string()),
}).strict();

const GitDiffSchema = z.object({
  gitRoot: NonEmptyStringSchema.nullable(),
  file: NonEmptyStringSchema,
  commit: z.string(),
  beforeContent: z.string(),
  afterContent: z.string(),
  diagnostics: z.array(z.string()),
}).strict();

const ProducerStatusSchema = z.object({
  language: NonEmptyStringSchema,
  kind: z.enum(["idle", "ready", "warming", "missing-tsconfig", "missing-package", "unsupported-package", "crashed", "stale", "disabled", "not-implemented"]),
  detail: z.string().optional(),
  warnings: z.array(z.object({ code: NonEmptyStringSchema, message: NonEmptyStringSchema }).strict()).optional(),
  generation: z.number().int().min(0).optional(),
}).strict();

const DoctorReportSchema = z.object({
  status: z.enum(["pass", "warn", "fail"]),
  checks: z.array(z.object({
    id: NonEmptyStringSchema,
    group: z.enum(["app", "generated-state", "install", "project", "project-map"]),
    status: z.enum(["pass", "warn", "fail"]),
    message: NonEmptyStringSchema,
    details: z.array(z.string()).optional(),
  }).strict()),
}).strict();

const FindingFixSchema = z.object({
  safety: z.enum(["safe", "suggested", "manual"]),
  description: NonEmptyStringSchema,
  command: NonEmptyStringSchema.optional(),
  edits: z.array(z.object({
    file: NonEmptyStringSchema,
    range: z.object({ startLine: z.number().int().positive(), startColumn: z.number().int().positive(), endLine: z.number().int().positive(), endColumn: z.number().int().positive() }).strict(),
    replacement: z.string(),
  }).strict()).optional(),
}).strict();

const FindingSchema = z.object({
  validatorId: NonEmptyStringSchema,
  severity: z.enum(["error", "warning"]),
  file: NonEmptyStringSchema,
  line: z.number().int().positive(),
  column: z.number().int().positive().optional(),
  message: NonEmptyStringSchema,
  fix: FindingFixSchema.optional(),
  docs: StringArraySchema.optional(),
  conventionIds: StringArraySchema.optional(),
}).strict();

const MissingConventionAdvisorySchema = z.object({
  kind: z.literal("missing-convention"),
  severity: z.literal("advisory"),
  title: z.literal("Missing convention?"),
  message: NonEmptyStringSchema,
  files: StringArraySchema,
  omittedFiles: z.number().int().min(0),
}).strict();

const GoverningConventionsSchema = z.object({
  files: StringArraySchema,
  conventions: z.array(z.object({
    id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    rule: NonEmptyStringSchema,
    docs: StringArraySchema,
    sources: z.array(z.enum(["applies", "impact-surface", "explicit"])),
    impactSurfaceIds: StringArraySchema,
  }).strict()),
  totalConventions: z.number().int().min(0),
  omittedConventions: z.number().int().min(0),
  truncated: z.boolean(),
  impactedSurfaceIds: StringArraySchema,
  advisory: MissingConventionAdvisorySchema.optional(),
}).strict();

const CommitGateEvidenceSchema = z.object({
  file: NonEmptyStringSchema.optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().positive().optional(),
  message: NonEmptyStringSchema.optional(),
  conventionIds: StringArraySchema.optional(),
  impactSurfaceIds: StringArraySchema.optional(),
}).strict();

const CommitGateSchema = z.object({
  id: NonEmptyStringSchema,
  title: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
  question: NonEmptyStringSchema,
  approvalScope: z.enum(["staged-diff", "file"]).optional(),
  file: NonEmptyStringSchema.optional(),
  line: z.number().int().positive().optional(),
  evidence: z.array(CommitGateEvidenceSchema).optional(),
  conventionIds: StringArraySchema.optional(),
  impactSurfaceIds: StringArraySchema.optional(),
  validatorId: NonEmptyStringSchema,
  status: z.enum(["unresolved", "approved"]).optional(),
  approvalId: NonEmptyStringSchema.optional(),
}).strict();

const ValidationResultSchema = z.object({
  files: StringArraySchema,
  validators: StringArraySchema,
  validatorGraphHash: NonEmptyStringSchema,
  findingCount: z.number().int().min(0),
  diagnostics: z.array(z.string()),
  findings: z.array(FindingSchema),
  validatorOutcomes: z.array(z.object({
    validatorId: NonEmptyStringSchema,
    status: z.enum(["ran", "skipped", "error"]),
    reason: z.string().optional(),
    producer: z.object({ language: NonEmptyStringSchema, generation: z.number().int().min(0) }).strict().optional(),
  }).strict()),
  producerSnapshot: z.record(z.string(), z.object({ kind: ProducerStatusSchema.shape.kind, generation: z.number().int().min(0) }).strict()),
  commitGates: z.array(CommitGateSchema),
  governingConventions: GoverningConventionsSchema.optional(),
  fixes: z.object({
    mode: z.enum(["safe", "suggested", "all"]),
    dryRun: z.boolean(),
    selectedEdits: z.number().int().min(0),
    appliedEdits: z.number().int().min(0),
    files: StringArraySchema,
    skipped: z.array(z.object({
      file: NonEmptyStringSchema,
      line: z.number().int().positive(),
      validatorId: NonEmptyStringSchema,
      safety: z.enum(["safe", "suggested", "manual"]),
      reason: NonEmptyStringSchema,
    }).strict()),
    diagnostics: z.array(z.string()),
  }).strict().optional(),
  profile: z.array(z.object({ name: NonEmptyStringSchema, ms: z.number().min(0), count: z.number().int().min(0) }).strict()).optional(),
}).strict();

const FeedbackChangeSchema = z.object({
  impactedSurfaces: z.array(z.object({ id: NonEmptyStringSchema, title: NonEmptyStringSchema, files: StringArraySchema, risks: z.array(z.string()), docs: StringArraySchema }).strict()),
  areas: z.array(z.object({ id: NonEmptyStringSchema, title: NonEmptyStringSchema, summary: z.string(), surfaces: StringArraySchema, docs: StringArraySchema, matches: StringArraySchema }).strict()),
  changes: z.array(z.object({
    id: NonEmptyStringSchema,
    title: NonEmptyStringSchema,
    kind: ChangeKindSchema,
    summary: z.string(),
    docs: StringArraySchema,
    scope: z.object({ files: StringArraySchema, docs: StringArraySchema }).strict(),
    updates: z.object({ areas: StringArraySchema, conventions: StringArraySchema, surfaces: StringArraySchema, docs: StringArraySchema }).strict(),
    matches: StringArraySchema,
  }).strict()),
  scopeDrift: z.object({
    kind: z.literal("scope-drift"),
    severity: z.literal("advisory"),
    title: z.literal("Scope drift?"),
    message: NonEmptyStringSchema,
    files: StringArraySchema,
    omittedFiles: z.number().int().min(0),
  }).strict().optional(),
}).strict();

const FeedbackResultSchema = z.object({
  host: z.enum(["manual", "codex", "claude", "opencode"]),
  files: StringArraySchema,
  diagnostics: z.array(z.string()),
  findingCount: z.number().int().min(0),
  suppressedCount: z.number().int().min(0),
  findings: z.array(FindingSchema),
  governingConventions: GoverningConventionsSchema.optional(),
  advisories: z.array(MissingConventionAdvisorySchema).optional(),
  change: FeedbackChangeSchema.optional(),
}).strict();

const HookFeedbackSchema = z.object({
  host: z.enum(["manual", "codex", "claude", "opencode"]),
  cwd: NonEmptyStringSchema,
  files: StringArraySchema,
  sessionId: NonEmptyStringSchema.optional(),
  turnId: NonEmptyStringSchema.optional(),
  result: FeedbackResultSchema,
  text: z.string(),
}).strict();

const ObservabilityAttributesSchema = z.record(z.string(), z.json());
const TelemetryResourceSchema = z.object({ attributes: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])), schemaUrl: NonEmptyStringSchema.optional() }).strict();
const ObservedErrorSchema: z.ZodType = z.lazy(() => z.object({ message: NonEmptyStringSchema, name: NonEmptyStringSchema, stack: z.string().optional(), cause: ObservedErrorSchema.optional() }).catchall(z.json()));
const TraceRecordSchema = z.object({
  id: NonEmptyStringSchema, name: NonEmptyStringSchema, status: z.enum(["in_progress", "ok", "error"]), recording: z.boolean(), sampled: z.boolean(),
  startedAt: z.string().datetime(), endedAt: z.string().datetime().optional(), durationMs: z.number().min(0).optional(), attributes: ObservabilityAttributesSchema,
  resource: TelemetryResourceSchema.optional(), parentTraceId: NonEmptyStringSchema.optional(), traceState: z.string().optional(), traceFlags: z.string().optional(), error: ObservedErrorSchema.optional(),
}).strict();
const SpanRecordSchema = z.object({
  id: NonEmptyStringSchema, traceId: NonEmptyStringSchema, parentSpanId: NonEmptyStringSchema.optional(), name: NonEmptyStringSchema,
  kind: z.enum(["internal", "server", "client", "producer", "consumer", "event_emit", "event_handle", "component", "http", "db", "llm", "task"]),
  otelKind: z.enum(["INTERNAL", "SERVER", "CLIENT", "PRODUCER", "CONSUMER"]), status: z.enum(["in_progress", "ok", "error"]), recording: z.boolean(),
  startedAt: z.string().datetime(), endedAt: z.string().datetime().optional(), durationMs: z.number().min(0).optional(), attributes: ObservabilityAttributesSchema,
  resource: TelemetryResourceSchema.optional(), traceParent: z.string(), traceState: z.string().optional(), traceFlags: z.string(), sampled: z.boolean(),
  output: ObservabilityAttributesSchema.optional(), error: ObservedErrorSchema.optional(),
}).strict();
const TraceEventRecordSchema = z.object({
  id: NonEmptyStringSchema, traceId: NonEmptyStringSchema, spanId: NonEmptyStringSchema.optional(), name: NonEmptyStringSchema, occurredAt: z.string().datetime(),
  resource: TelemetryResourceSchema.optional(), traceFlags: z.string().optional(), sampled: z.boolean().optional(), attributes: ObservabilityAttributesSchema.optional(),
}).strict();
const ObservabilityResultSchema = z.object({ traces: z.array(TraceRecordSchema), spans: z.array(SpanRecordSchema), events: z.array(TraceEventRecordSchema) }).strict();

const ProjectSettingsSchema = z.object({
  rootDir: NonEmptyStringSchema,
  configPath: NonEmptyStringSchema,
  hasConfig: z.boolean(),
  defaults: JsonObjectSchema,
  effective: JsonObjectSchema,
  overrides: JsonObjectSchema,
  diagnostics: z.array(z.string()),
}).strict();

const AuthoringFixtureFileSchema = z.object({ path: NonEmptyStringSchema, content: z.string() }).strict();
const AuthoringFixtureSetSchema = z.object({ valid: z.array(AuthoringFixtureFileSchema), invalid: z.array(AuthoringFixtureFileSchema) }).strict();
const AuthoringFieldSchema = z.object({
  key: NonEmptyStringSchema,
  label: NonEmptyStringSchema,
  kind: z.enum(["boolean", "lines", "number", "regex-lines", "select", "text", "textarea"]),
  required: z.boolean().optional(),
  options: StringArraySchema.optional(),
  placeholder: z.string().optional(),
}).strict();
const AuthoringFactorySchema = z.object({ id: NonEmptyStringSchema, label: NonEmptyStringSchema, summary: NonEmptyStringSchema, fields: z.array(AuthoringFieldSchema), defaults: JsonObjectSchema, fixtures: AuthoringFixtureSetSchema }).strict();
const AuthoringValidatorSchema = z.object({ id: NonEmptyStringSchema, severity: NonEmptyStringSchema, scope: NonEmptyStringSchema, topics: StringArraySchema, sourcePath: NonEmptyStringSchema.optional(), fixtureCases: z.array(z.enum(["valid", "invalid"])) }).strict();
const AuthoringPreviewSchema = z.object({ validatorId: NonEmptyStringSchema, validatorPath: NonEmptyStringSchema, indexPath: NonEmptyStringSchema, importName: NonEmptyStringSchema, source: z.string() }).strict();
const AuthoringRunSchema = z.object({ passed: z.boolean(), cases: z.array(z.object({ case: z.enum(["valid", "invalid"]), passed: z.boolean(), findings: z.array(FindingSchema), details: z.array(z.string()) }).strict()) }).strict();

const ServiceProjectSchema = z.object({
  id: NonEmptyStringSchema,
  rootDir: NonEmptyStringSchema,
  url: z.string(),
  status: z.enum(["failed", "running", "starting", "unhealthy", "stale"]),
  selected: z.boolean(),
  pid: z.number().int().positive().optional(),
  port: z.number().int().positive().optional(),
  files: z.number().int().min(0).optional(),
  findings: z.number().int().min(0).optional(),
}).strict();

const TreeResponseSchema = z.object({
  path: z.string(),
  entries: z.array(z.object({ name: NonEmptyStringSchema, path: NonEmptyStringSchema, kind: z.enum(["file", "dir"]), indexed: z.boolean(), findingCount: z.number().int().min(0), language: NonEmptyStringSchema.optional() }).strict()),
}).strict();
const FileResponseSchema = z.object({ path: NonEmptyStringSchema, language: NonEmptyStringSchema, bytes: z.number().int().min(0), content: z.string() }).strict();

const PendingGateSchema = CommitGateSchema.extend({
  status: z.literal("unresolved"),
  question: NonEmptyStringSchema,
  agentAction: z.literal("request_user_input"),
  agentProtocol: StringArraySchema,
  preferredToolNames: StringArraySchema,
  plainChatFallbackAllowed: z.literal(true),
  fallbackProtocol: NonEmptyStringSchema,
  choices: z.array(z.object({ label: z.enum(["Approve", "Reject"]), description: NonEmptyStringSchema }).strict()),
  approveCommand: NonEmptyStringSchema,
}).strict();
const CommitApprovalContextSchema = z.object({
  rootDir: NonEmptyStringSchema,
  diffFingerprint: NonEmptyStringSchema,
  stagedDiffFingerprint: NonEmptyStringSchema,
  worktreeDiffFingerprint: NonEmptyStringSchema,
  changedFiles: StringArraySchema,
  stagedFiles: StringArraySchema,
  worktreeFiles: StringArraySchema,
  untrackedFiles: StringArraySchema,
  configHash: NonEmptyStringSchema,
  validatorGraphHash: NonEmptyStringSchema,
  diagnostics: z.array(z.string()),
}).strict();
const PendingGatesFileSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  context: CommitApprovalContextSchema,
  pending: z.array(PendingGateSchema),
  approved: z.array(CommitGateSchema),
  diagnostics: z.array(z.string()),
  governingConventions: GoverningConventionsSchema.optional(),
}).strict();
const CommitApprovalRecordSchema = z.object({
  id: NonEmptyStringSchema, gateId: NonEmptyStringSchema, gateTitle: NonEmptyStringSchema, gateReason: NonEmptyStringSchema, validatorId: NonEmptyStringSchema,
  approvalScope: z.enum(["staged-diff", "file"]), approvalFingerprint: NonEmptyStringSchema, changedFiles: StringArraySchema, summary: NonEmptyStringSchema,
  approvedAt: z.string().datetime(), approvedBy: NonEmptyStringSchema, approvedVia: z.enum(["cli", "agent", "manual"]), configHash: NonEmptyStringSchema,
  validatorGraphHash: NonEmptyStringSchema, conventionIds: StringArraySchema, impactSurfaceIds: StringArraySchema, evidence: z.array(CommitGateEvidenceSchema),
}).strict();

export const ProtocolOperationOutputSchemas = Object.freeze({
  "health.read": HealthOutputSchema,
  "project.state": RuntimeLiveStateSchema,
  "project.summary": RuntimeProjectSummarySchema,
  "knowledge.status": ReadSemanticIndexStatusResultSchema,
  "code.symbols": CodeSymbolsSchema,
  "code.graph": CodeGraphSchema,
  "knowledge.chunks": ListSemanticChunksResultSchema,
  "knowledge.search": ProjectContextSearchResultSchema,
  "knowledge.ask": ProjectContextAskResultSchema,
  "knowledge.coverage": ProjectContextCoverageResultSchema,
  "context.packet": ContextPacketSchema,
  "knowledge.backlinks": ProjectContextBacklinksResultSchema,
  "changes.list": z.array(SnapshotChangeSchema),
  "changes.ready": ChangeWorkQueueSchema,
  "worktrees.list": WorktreeOverviewSchema,
  "proof.runs.read": ChangeCheckRunsReadSchema,
  "proof.runs.start": StartChangeCheckRunsResponseSchema,
  "proof.runs.cancel": ChangeCheckRunSnapshotSchema,
  "activity.list": z.array(CanonEventSchema),
  "activity.record": ActivityRecordResultSchema,
  "canon.related.read": RelatedCanonSchema,
  "canon.related.query": RelatedCanonSchema,
  "events.stream": ProjectProtocolEventSchema,
  "events.list": ProtocolEventReplaySchema,
  "observability.list": ObservabilityResultSchema,
  "canon.history": CanonHistorySchema,
  "git.history": GitHistorySchema,
  "git.diff": GitDiffSchema,
  "producers.list": z.object({ producers: z.array(ProducerStatusSchema) }).strict(),
  "doctor.run": DoctorReportSchema,
  "validation.run": ValidationResultSchema,
  "validators.list": RuntimeValidatorCatalogSchema,
  "feedback.query": FeedbackResultSchema,
  "hooks.feedback": z.object({ feedback: HookFeedbackSchema, response: z.string() }).strict(),
  "knowledge.index": z.object({ semanticIndex: SemanticIndexSnapshotSchema.nullable() }).strict(),
  "settings.read": ProjectSettingsSchema,
  "settings.write": ProjectSettingsSchema,
  "authoring.factories": z.array(AuthoringFactorySchema),
  "authoring.validators": z.array(AuthoringValidatorSchema),
  "authoring.validators.preview": AuthoringPreviewSchema,
  "authoring.validators.fixtures": AuthoringRunSchema,
  "authoring.validators.apply": z.object({ preview: AuthoringPreviewSchema, run: AuthoringRunSchema }).strict(),
  "service.projects": z.array(ServiceProjectSchema),
  "filesystem.tree": TreeResponseSchema,
  "filesystem.file": FileResponseSchema,
  "findings.list": z.array(CanonFindingSchema),
  "gates.pending": PendingGatesFileSchema,
  "gates.approve": z.object({ approval: CommitApprovalRecordSchema, gates: PendingGatesFileSchema }).strict(),
} as const);

export type ProtocolOperationOutputSchemaMap = typeof ProtocolOperationOutputSchemas;
export type ProtocolOperationOutput<TId extends keyof ProtocolOperationOutputSchemaMap> = z.output<ProtocolOperationOutputSchemaMap[TId]>;
