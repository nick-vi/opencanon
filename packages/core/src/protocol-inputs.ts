import { z } from "zod";
import { ChangeCheckRunStatusSchema } from "./contracts-change-runs.ts";
import { ProducerPolicySchema } from "./producer-registry.ts";

const NonEmptyStringSchema = z.string().trim().min(1);
const OptionalStringSchema = z.string();
const PositiveIntegerStringSchema = z.string().regex(/^[1-9][0-9]*$/);
const NonNegativeIntegerStringSchema = z.string().regex(/^(?:0|[1-9][0-9]*)$/);
const BooleanFlagStringSchema = z.enum(["0", "1"]);
const StringListSchema = z.union([z.string(), z.array(z.string())]);

const EmptyInputSchema = z.object({}).strict();

function queryInput<TQuery extends z.ZodType>(query: TQuery) {
  return z.object({ query: query.optional() }).strict();
}

function requiredQueryInput<TQuery extends z.ZodType>(query: TQuery) {
  return z.object({ query }).strict();
}

function bodyInput<TBody extends z.ZodType>(body: TBody) {
  return z.object({ body }).strict();
}

function optionalBodyInput<TBody extends z.ZodType>(body: TBody) {
  return z.object({ body: body.optional() }).strict();
}

const PaginationQuerySchema = z.object({
  limit: PositiveIntegerStringSchema.optional(),
  offset: NonNegativeIntegerStringSchema.optional(),
}).strict();

const CodeSymbolsQuerySchema = z.object({
  query: OptionalStringSchema.optional(),
  path: OptionalStringSchema.optional(),
  source: OptionalStringSchema.optional(),
  kind: OptionalStringSchema.optional(),
  limit: PositiveIntegerStringSchema.optional(),
  references: BooleanFlagStringSchema.optional(),
}).strict();

const CodeGraphQuerySchema = z.object({
  query: OptionalStringSchema.optional(),
  symbolId: OptionalStringSchema.optional(),
  path: OptionalStringSchema.optional(),
  kind: OptionalStringSchema.optional(),
  direction: z.enum(["incoming", "outgoing", "both"]).optional(),
  limit: PositiveIntegerStringSchema.optional(),
}).strict();

const KnowledgeChunksQuerySchema = z.object({
  path: StringListSchema.optional(),
  definition: StringListSchema.optional(),
  limit: PositiveIntegerStringSchema.optional(),
  offset: NonNegativeIntegerStringSchema.optional(),
}).strict();

const KnowledgeSearchQuerySchema = z.object({
  query: NonEmptyStringSchema,
  path: StringListSchema.optional(),
  limit: PositiveIntegerStringSchema.optional(),
}).strict();

const ContextPacketQuerySchema = z.object({
  file: StringListSchema.optional(),
  changeId: StringListSchema.optional(),
  mode: NonEmptyStringSchema.optional(),
  limit: PositiveIntegerStringSchema.optional(),
}).strict();

const KnowledgeBacklinksQuerySchema = z.object({
  query: NonEmptyStringSchema.optional(),
  id: NonEmptyStringSchema.optional(),
  path: NonEmptyStringSchema.optional(),
}).strict().refine((value) => Boolean(value.query || value.id || value.path), {
  message: "query, id, or path is required",
});

const ChangeCheckRunsQuerySchema = z.object({
  runId: NonEmptyStringSchema.optional(),
  after: NonNegativeIntegerStringSchema.optional(),
  status: ChangeCheckRunStatusSchema.optional(),
  limit: PositiveIntegerStringSchema.optional(),
}).strict();

const StartChangeCheckRunsBodySchema = z.object({
  changeId: NonEmptyStringSchema,
  taskId: NonEmptyStringSchema.optional(),
  checkId: NonEmptyStringSchema.optional(),
  all: z.boolean().optional(),
  actor: NonEmptyStringSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.all === true && value.checkId) {
    context.addIssue({ code: "custom", path: ["checkId"], message: "checkId and all cannot be used together" });
  }
  if (value.all !== true && !value.checkId) {
    context.addIssue({ code: "custom", path: ["checkId"], message: "checkId is required unless all is true" });
  }
});

const ChangeActivityQuerySchema = z.object({
  changeId: NonEmptyStringSchema.optional(),
  taskId: NonEmptyStringSchema.optional(),
  checkId: NonEmptyStringSchema.optional(),
  limit: PositiveIntegerStringSchema.optional(),
}).strict();

const ChangeActivityBodySchema = z.object({
  id: NonEmptyStringSchema,
  changeId: NonEmptyStringSchema,
  taskId: NonEmptyStringSchema.optional(),
  checkId: NonEmptyStringSchema.optional(),
  type: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  actor: NonEmptyStringSchema.optional(),
  files: z.array(NonEmptyStringSchema).optional(),
}).strict();

const RelatedCanonQuerySchema = z.object({
  file: StringListSchema.optional(),
  topic: StringListSchema.optional(),
  conventionId: StringListSchema.optional(),
  validatorId: StringListSchema.optional(),
  findingId: StringListSchema.optional(),
}).strict();

const RelatedCanonBodySchema = z.object({
  files: z.array(NonEmptyStringSchema).optional(),
  topics: z.array(NonEmptyStringSchema).optional(),
  conventionIds: z.array(NonEmptyStringSchema).optional(),
  validatorIds: z.array(NonEmptyStringSchema).optional(),
  findingIds: z.array(NonEmptyStringSchema).optional(),
}).strict();

const ProtocolEventsQuerySchema = z.object({
  afterSequence: NonNegativeIntegerStringSchema.optional(),
  operationId: NonEmptyStringSchema.optional(),
  limit: PositiveIntegerStringSchema.optional(),
}).strict();

const ObservabilityQuerySchema = z.object({
  traceId: NonEmptyStringSchema.optional(),
  limit: PositiveIntegerStringSchema.optional(),
}).strict();

const CanonHistoryQuerySchema = z.object({
  kind: z.enum(["convention", "area", "spec", "change"]),
  id: NonEmptyStringSchema,
}).strict();

const GitHistoryQuerySchema = z.object({
  file: StringListSchema,
  limit: PositiveIntegerStringSchema.optional(),
}).strict();

const GitDiffQuerySchema = z.object({
  file: NonEmptyStringSchema,
  commit: z.string().regex(/^[a-fA-F0-9]{7,40}$/),
}).strict();

const ValidationBodySchema = z.object({
  files: z.array(NonEmptyStringSchema).optional(),
  topics: z.array(NonEmptyStringSchema).optional(),
  validatorIds: z.array(NonEmptyStringSchema).optional(),
  project: z.boolean().optional(),
  fixMode: z.enum(["safe", "suggested", "all"]).optional(),
  dryRun: z.boolean().optional(),
  strictProducers: z.boolean().optional(),
  profile: z.boolean().optional(),
  producerPolicy: ProducerPolicySchema.optional(),
}).strict();

const FeedbackBodySchema = z.object({
  files: z.array(NonEmptyStringSchema).optional(),
  host: z.enum(["manual", "codex", "claude", "opencode"]).optional(),
  sessionId: NonEmptyStringSchema.optional(),
  turnId: NonEmptyStringSchema.optional(),
  dedupeScope: z.enum(["off", "turn", "session"]).optional(),
}).strict();

const HookFeedbackBodySchema = z.object({
  host: z.enum(["manual", "codex", "claude", "opencode"]),
  payload: z.json(),
}).strict();

const SettingsWriteBodySchema = z.object({
  overrides: z.record(z.string(), z.json()),
}).strict();

const AuthoringFixtureFileSchema = z.object({
  path: NonEmptyStringSchema,
  content: z.string(),
}).strict();

const AuthoringRequestBodySchema = z.object({
  factoryId: NonEmptyStringSchema,
  options: z.record(z.string(), z.json()),
  fixtures: z.object({
    valid: z.array(AuthoringFixtureFileSchema),
    invalid: z.array(AuthoringFixtureFileSchema),
  }).strict(),
}).strict();

const FileTreeQuerySchema = z.object({
  path: OptionalStringSchema.optional(),
  scope: z.enum(["all", "canon"]).optional(),
  query: OptionalStringSchema.optional(),
  dot: BooleanFlagStringSchema.optional(),
  withFindings: BooleanFlagStringSchema.optional(),
}).strict();

const GateApprovalBodySchema = z.object({
  gateId: NonEmptyStringSchema,
  summary: NonEmptyStringSchema,
  approvedBy: NonEmptyStringSchema.optional(),
}).strict();

export const ProtocolOperationInputSchemas = Object.freeze({
  "health.read": EmptyInputSchema,
  "project.state": EmptyInputSchema,
  "project.summary": EmptyInputSchema,
  "knowledge.status": EmptyInputSchema,
  "code.symbols": queryInput(CodeSymbolsQuerySchema),
  "code.graph": queryInput(CodeGraphQuerySchema),
  "knowledge.chunks": queryInput(KnowledgeChunksQuerySchema),
  "knowledge.search": requiredQueryInput(KnowledgeSearchQuerySchema),
  "knowledge.ask": requiredQueryInput(KnowledgeSearchQuerySchema.pick({ query: true })),
  "knowledge.coverage": EmptyInputSchema,
  "context.packet": queryInput(ContextPacketQuerySchema),
  "knowledge.backlinks": requiredQueryInput(KnowledgeBacklinksQuerySchema),
  "changes.list": EmptyInputSchema,
  "changes.ready": EmptyInputSchema,
  "worktrees.list": EmptyInputSchema,
  "proof.runs.read": queryInput(ChangeCheckRunsQuerySchema),
  "proof.runs.start": bodyInput(StartChangeCheckRunsBodySchema),
  "proof.runs.cancel": bodyInput(z.object({ runId: NonEmptyStringSchema }).strict()),
  "activity.list": queryInput(ChangeActivityQuerySchema),
  "activity.record": bodyInput(ChangeActivityBodySchema),
  "canon.related.read": queryInput(RelatedCanonQuerySchema),
  "canon.related.query": optionalBodyInput(RelatedCanonBodySchema),
  "events.stream": queryInput(ProtocolEventsQuerySchema.omit({ limit: true })),
  "events.list": queryInput(ProtocolEventsQuerySchema),
  "observability.list": queryInput(ObservabilityQuerySchema),
  "canon.history": requiredQueryInput(CanonHistoryQuerySchema),
  "git.history": requiredQueryInput(GitHistoryQuerySchema),
  "git.diff": requiredQueryInput(GitDiffQuerySchema),
  "producers.list": EmptyInputSchema,
  "doctor.run": EmptyInputSchema,
  "validation.run": optionalBodyInput(ValidationBodySchema),
  "validators.list": queryInput(PaginationQuerySchema),
  "feedback.query": optionalBodyInput(FeedbackBodySchema),
  "hooks.feedback": bodyInput(HookFeedbackBodySchema),
  "knowledge.index": optionalBodyInput(z.object({ force: z.boolean().optional() }).strict()),
  "settings.read": EmptyInputSchema,
  "settings.write": bodyInput(SettingsWriteBodySchema),
  "authoring.factories": EmptyInputSchema,
  "authoring.validators": EmptyInputSchema,
  "authoring.validators.preview": bodyInput(AuthoringRequestBodySchema),
  "authoring.validators.fixtures": bodyInput(AuthoringRequestBodySchema),
  "authoring.validators.apply": bodyInput(AuthoringRequestBodySchema),
  "service.projects": EmptyInputSchema,
  "filesystem.tree": queryInput(FileTreeQuerySchema),
  "filesystem.file": requiredQueryInput(z.object({ path: NonEmptyStringSchema }).strict()),
  "findings.list": queryInput(z.object({ file: NonEmptyStringSchema.optional() }).strict()),
  "gates.pending": EmptyInputSchema,
  "gates.approve": bodyInput(GateApprovalBodySchema),
} as const);

export type ProtocolOperationInputSchemaMap = typeof ProtocolOperationInputSchemas;
export type ProtocolOperationInput<TId extends keyof ProtocolOperationInputSchemaMap> = z.input<ProtocolOperationInputSchemaMap[TId]>;
