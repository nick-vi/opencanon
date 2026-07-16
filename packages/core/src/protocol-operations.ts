import { z } from "zod";
import {
  ReadSemanticIndexStatusResultSchema,
} from "./contracts-semantic.ts";
import {
  RuntimeHealthSchema,
  RuntimeLiveStateSchema,
  RuntimeProjectSummarySchema,
  RuntimeValidatorCatalogSchema,
} from "./contracts-runtime.ts";
import {
  DomainProtocolVersion,
  ProtocolAuthorization,
  ProtocolConsistency,
  ProtocolCost,
  ProtocolHttpMethod,
  ProtocolIdempotency,
  ProtocolInputSchema,
  ProtocolOperationKind,
  ProjectProtocolEventSchema,
  ProtocolEventReplaySchema,
  ProjectionResponseSchema,
  defineProtocolOperation,
  type ProtocolOperationDefinition,
} from "./protocol.ts";

export const ProtocolRoute = {
  CanonRelated: "/api/canon/related",
  CanonHistory: "/api/canon/history",
  Changes: "/api/changes",
  ChangeCheckRuns: "/api/changes/check-runs",
  ChangeCheckRunsCancel: "/api/changes/check-runs/cancel",
  ChangeEvents: "/api/changes/events",
  ChangeReady: "/api/changes/ready",
  CodeGraph: "/api/code/graph",
  CodeSymbols: "/api/code/symbols",
  ContextAsk: "/api/context/ask",
  ContextBacklinks: "/api/context/backlinks",
  ContextChunks: "/api/context/chunks",
  ContextCoverage: "/api/context/coverage",
  ContextPacket: "/api/context/packet",
  ContextSearch: "/api/context/search",
  ContextStatus: "/api/context/status",
  Doctor: "/api/doctor",
  Events: "/api/events",
  EventsStream: "/api/events/stream",
  Feedback: "/api/feedback",
  Findings: "/api/findings",
  FsFile: "/api/fs/file",
  FsTree: "/api/fs/tree",
  GitDiff: "/api/git/diff",
  GitHistory: "/api/git/history",
  GateApprove: "/api/gates/approve",
  GatePending: "/api/gates/pending",
  Health: "/api/health",
  HookFeedback: "/api/hook-feedback",
  Index: "/api/index",
  Observability: "/api/observability",
  Producers: "/api/producers",
  ProjectSummary: "/api/project/summary",
  Settings: "/api/settings",
  State: "/api/state",
  AuthoringFactories: "/api/authoring/factories",
  AuthoringValidators: "/api/authoring/validators",
  AuthoringValidatorsApply: "/api/authoring/validators/apply",
  AuthoringValidatorsPreview: "/api/authoring/validators/preview",
  AuthoringValidatorsRunFixtures: "/api/authoring/validators/run-fixtures",
  ServiceProjects: "/api/service/projects",
  Validate: "/api/validate",
  Validators: "/api/validators",
  Worktrees: "/api/worktrees",
} as const;

export const ProtocolApiPathPrefix = "/api/";

const JsonValueSchema = z.json();
const PublicHealthSchema = z.object({ status: z.literal("ok") }).strict();
const HealthOutputSchema = z.union([PublicHealthSchema, RuntimeHealthSchema]);

const Limits = {
  Tiny: Object.freeze({ requestBytes: 16 * 1024, responseBytes: 256 * 1024, concurrency: 32 }),
  Bounded: Object.freeze({ requestBytes: 256 * 1024, responseBytes: 4 * 1024 * 1024, concurrency: 16 }),
  Operation: Object.freeze({ requestBytes: 1024 * 1024, responseBytes: 4 * 1024 * 1024, concurrency: 2 }),
  Stream: Object.freeze({ requestBytes: 16 * 1024, responseBytes: 64 * 1024, concurrency: 32 }),
} as const;

type OperationInput<TId extends string = string> = {
  id: TId;
  kind: (typeof ProtocolOperationKind)[keyof typeof ProtocolOperationKind];
  method: (typeof ProtocolHttpMethod)[keyof typeof ProtocolHttpMethod];
  path: (typeof ProtocolRoute)[keyof typeof ProtocolRoute];
  authorization?: (typeof ProtocolAuthorization)[keyof typeof ProtocolAuthorization];
  consistency?: (typeof ProtocolConsistency)[keyof typeof ProtocolConsistency];
  cost?: (typeof ProtocolCost)[keyof typeof ProtocolCost];
  idempotency?: (typeof ProtocolIdempotency)[keyof typeof ProtocolIdempotency];
  cancellable?: boolean;
  limits?: (typeof Limits)[keyof typeof Limits];
  outputSchema?: z.ZodType;
};

function operation<const TId extends string>(input: OperationInput<TId>): ProtocolOperationDefinition<TId> {
  const cost = input.cost ?? ProtocolCost.Bounded;
  const domainOutputSchema = input.outputSchema ?? JsonValueSchema;
  return defineProtocolOperation({
    id: input.id,
    version: DomainProtocolVersion,
    kind: input.kind,
    method: input.method,
    path: input.path,
    authorization: input.authorization ?? ProtocolAuthorization.Project,
    consistency: input.consistency ?? ProtocolConsistency.Published,
    cost,
    idempotency: input.idempotency ?? (input.kind === ProtocolOperationKind.Query || input.kind === ProtocolOperationKind.Stream
      ? ProtocolIdempotency.Safe
      : ProtocolIdempotency.Unsafe),
    cancellable: input.cancellable ?? false,
    limits: input.limits ?? (cost === ProtocolCost.Tiny ? Limits.Tiny : cost === ProtocolCost.Operation ? Limits.Operation : Limits.Bounded),
    span: `opencanon.${input.id}`,
    inputSchema: ProtocolInputSchema,
    outputSchema: input.kind === ProtocolOperationKind.Query ? ProjectionResponseSchema(domainOutputSchema) : domainOutputSchema,
  });
}

const query = <const TId extends string>(id: TId, path: OperationInput["path"], input: Omit<OperationInput, "id" | "kind" | "method" | "path"> = {}) =>
  operation({ id, kind: ProtocolOperationKind.Query, method: ProtocolHttpMethod.Get, path, ...input });
const postQuery = <const TId extends string>(id: TId, path: OperationInput["path"], input: Omit<OperationInput, "id" | "kind" | "method" | "path"> = {}) =>
  operation({ id, kind: ProtocolOperationKind.Query, method: ProtocolHttpMethod.Post, path, ...input });
const command = <const TId extends string>(id: TId, path: OperationInput["path"], input: Omit<OperationInput, "id" | "kind" | "method" | "path"> = {}) =>
  operation({ id, kind: ProtocolOperationKind.Command, method: ProtocolHttpMethod.Post, path, ...input });

export const ProtocolOperations = Object.freeze([
  query("health.read", ProtocolRoute.Health, {
    authorization: ProtocolAuthorization.Public,
    consistency: ProtocolConsistency.Lifecycle,
    cost: ProtocolCost.Tiny,
    limits: Limits.Tiny,
    outputSchema: HealthOutputSchema,
  }),
  query("project.state", ProtocolRoute.State, { consistency: ProtocolConsistency.Lifecycle, cost: ProtocolCost.Tiny, outputSchema: RuntimeLiveStateSchema }),
  query("project.summary", ProtocolRoute.ProjectSummary, { cost: ProtocolCost.Tiny, outputSchema: RuntimeProjectSummarySchema }),
  query("knowledge.status", ProtocolRoute.ContextStatus, { cost: ProtocolCost.Tiny, outputSchema: ReadSemanticIndexStatusResultSchema }),
  query("code.symbols", ProtocolRoute.CodeSymbols),
  query("code.graph", ProtocolRoute.CodeGraph),
  query("knowledge.chunks", ProtocolRoute.ContextChunks),
  query("knowledge.search", ProtocolRoute.ContextSearch, { cost: ProtocolCost.Operation, cancellable: true, limits: Limits.Operation }),
  query("knowledge.ask", ProtocolRoute.ContextAsk, { cost: ProtocolCost.Operation, cancellable: true, limits: Limits.Operation }),
  query("knowledge.coverage", ProtocolRoute.ContextCoverage),
  query("context.packet", ProtocolRoute.ContextPacket),
  query("knowledge.backlinks", ProtocolRoute.ContextBacklinks),
  query("changes.list", ProtocolRoute.Changes),
  query("changes.ready", ProtocolRoute.ChangeReady),
  query("worktrees.list", ProtocolRoute.Worktrees),
  query("proof.runs.read", ProtocolRoute.ChangeCheckRuns),
  command("proof.runs.start", ProtocolRoute.ChangeCheckRuns, { cost: ProtocolCost.Operation, cancellable: true, limits: Limits.Operation }),
  command("proof.runs.cancel", ProtocolRoute.ChangeCheckRunsCancel, { idempotency: ProtocolIdempotency.Safe, cost: ProtocolCost.Tiny }),
  query("activity.list", ProtocolRoute.ChangeEvents),
  command("activity.record", ProtocolRoute.ChangeEvents, { idempotency: ProtocolIdempotency.Keyed }),
  query("canon.related.read", ProtocolRoute.CanonRelated),
  postQuery("canon.related.query", ProtocolRoute.CanonRelated),
  operation({
    id: "events.stream",
    kind: ProtocolOperationKind.Stream,
    method: ProtocolHttpMethod.Get,
    path: ProtocolRoute.EventsStream,
    consistency: ProtocolConsistency.Lifecycle,
    cost: ProtocolCost.Tiny,
    idempotency: ProtocolIdempotency.Safe,
    limits: Limits.Stream,
    outputSchema: ProjectProtocolEventSchema,
  }),
  query("events.list", ProtocolRoute.Events, { outputSchema: ProtocolEventReplaySchema }),
  query("observability.list", ProtocolRoute.Observability),
  query("canon.history", ProtocolRoute.CanonHistory),
  query("git.history", ProtocolRoute.GitHistory),
  query("git.diff", ProtocolRoute.GitDiff),
  query("producers.list", ProtocolRoute.Producers, { consistency: ProtocolConsistency.Lifecycle, cost: ProtocolCost.Tiny }),
  query("doctor.run", ProtocolRoute.Doctor, { consistency: ProtocolConsistency.Lifecycle, cost: ProtocolCost.Operation, limits: Limits.Operation }),
  postQuery("validation.run", ProtocolRoute.Validate, { cost: ProtocolCost.Operation, limits: Limits.Operation }),
  query("validators.list", ProtocolRoute.Validators, { outputSchema: RuntimeValidatorCatalogSchema }),
  postQuery("feedback.query", ProtocolRoute.Feedback, { cost: ProtocolCost.Operation, limits: Limits.Operation }),
  postQuery("hooks.feedback", ProtocolRoute.HookFeedback, { cost: ProtocolCost.Operation, limits: Limits.Operation }),
  command("knowledge.index", ProtocolRoute.Index, { cost: ProtocolCost.Operation, limits: Limits.Operation }),
  query("settings.read", ProtocolRoute.Settings, { consistency: ProtocolConsistency.Lifecycle, cost: ProtocolCost.Tiny }),
  command("settings.write", ProtocolRoute.Settings, { consistency: ProtocolConsistency.Lifecycle }),
  query("authoring.factories", ProtocolRoute.AuthoringFactories),
  query("authoring.validators", ProtocolRoute.AuthoringValidators),
  postQuery("authoring.validators.preview", ProtocolRoute.AuthoringValidatorsPreview),
  postQuery("authoring.validators.fixtures", ProtocolRoute.AuthoringValidatorsRunFixtures, { cost: ProtocolCost.Operation, limits: Limits.Operation }),
  command("authoring.validators.apply", ProtocolRoute.AuthoringValidatorsApply),
  query("service.projects", ProtocolRoute.ServiceProjects, { consistency: ProtocolConsistency.Lifecycle, cost: ProtocolCost.Tiny }),
  query("filesystem.tree", ProtocolRoute.FsTree),
  query("filesystem.file", ProtocolRoute.FsFile, { limits: Limits.Bounded }),
  query("findings.list", ProtocolRoute.Findings),
  query("gates.pending", ProtocolRoute.GatePending),
  command("gates.approve", ProtocolRoute.GateApprove, { idempotency: ProtocolIdempotency.Keyed }),
] satisfies ProtocolOperationDefinition[]);

const operationsById = new Map<string, ProtocolOperationDefinition>(ProtocolOperations.map((item) => [item.id, item]));
const operationsByRequest = new Map<string, ProtocolOperationDefinition>(ProtocolOperations.map((item) => [operationRequestKey(item.method, item.path), item]));

assertUniqueRegistry();

export type ProtocolOperationId = (typeof ProtocolOperations)[number]["id"];

export function findProtocolOperation(method: string, path: string): ProtocolOperationDefinition | undefined {
  return operationsByRequest.get(operationRequestKey(method, path));
}

export function protocolOperationById(id: string): ProtocolOperationDefinition | undefined {
  return operationsById.get(id);
}

export function protocolMethodsForPath(path: string): ProtocolHttpMethod[] {
  return ProtocolOperations.filter((item) => item.path === path).map((item) => item.method);
}

export function maximumProtocolRequestBytes(): number {
  return Math.max(...ProtocolOperations.map((item) => item.limits.requestBytes));
}

function operationRequestKey(method: string, path: string): string {
  return `${method.toUpperCase()} ${path}`;
}

function assertUniqueRegistry(): void {
  if (operationsById.size !== ProtocolOperations.length) throw new Error("Protocol operation ids must be unique.");
  if (operationsByRequest.size !== ProtocolOperations.length) throw new Error("Protocol method and path pairs must be unique.");
}
