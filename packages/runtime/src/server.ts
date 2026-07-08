import { createServer, type IncomingMessage, type Server as NodeHttpServer, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { exec as execShell } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, watch, type FSWatcher } from "node:fs";
import type { Socket } from "node:net";
import path from "node:path";
import { promisify } from "node:util";
import {
  CryptoIdGenerator,
  NoopLogger,
  SimpleTracer,
  SpanKind,
  SystemClock,
  serviceTelemetryResource,
} from "@opencanon/observability";
import {
  createHookFeedback,
  CanonEventSchema,
  createCommitApprovalRecord,
  createPaths,
  createOpenCanonDiagnostic,
  createProfiler,
  getOpenCanonErrorDiagnostics,
  formatOpenCanonDiagnostics,
  ChangeCheckKind,
  ChangeCheckEventType,
  ChangeLifecycleEventType,
  ChangeTaskEventType,
  buildDefinitionHistoryGitArgs,
  deriveChangeWorkQueue,
  definitionTargetFiles,
  buildDoctorReport,
  loadCommitApprovalsWithDiagnostics,
  loadAreaHistoryTarget,
  loadChangeHistoryTarget,
  loadConventionHistoryTarget,
  loadSpecHistoryTarget,
  loadPendingCommitGates,
  loadProjectContext,
  parseConventionGitLog,
  renderHookResponse,
  resource,
  resolveCommitGates,
  runFeedback,
  runGit as runConventionGit,
  runValidation,
  saveCommitApprovals,
  savePendingCommitGates,
  resolveRootDir,
  upsertCommitApproval,
  validateConfig,
  DefaultSemanticEmbeddingConfig,
  ProjectRefreshModeValue,
  ProjectRefreshStatusValue,
  RuntimeWorkerJobKindValue,
  RuntimeWorkerJobStatusValue,
  TaskLeaseStatus,
  BatchProducerPolicy,
  InteractiveProducerPolicy,
  ProducerRunProfile,
  type FeedbackHost,
  type FixMode,
  type CanonEvent,
  type Change,
  type ChangeCheck,
  type DefinitionHistoryKind,
  type DefinitionHistoryTarget,
  type ProducerPolicy,
  type RuntimeWorkerJob,
  type WatcherEventBatch,
} from "@opencanon/core";
import { buildRuntimeSnapshot, buildProjectSummary, buildRelatedCanon, runtimeSnapshotFailure, gitDiffSnapshot, gitHistorySnapshot, type RuntimeSnapshot } from "./snapshot.ts";
import { TreeScope, buildTreeResponse, listProjectInventory, readFileResponse, treeScopeParam, validateCommitHash, validateOptionalRelativePaths, validateRelativePath, validateRelativePaths } from "./server-fs.ts";
import { createEventBroadcaster, eventStream, indexedEvent, indexingEvent, snapshotEvent, streamErrorEvent } from "./server-events.ts";
import { assertRuntimePrerequisites, formatHttpBaseUrl, renderPrerequisiteFailure, requiredNodeRequirement } from "./runtime.ts";
import { createProjectStore, type ProjectStore } from "./state.ts";
import { readProjectSettings, writeProjectSettings } from "./settings.ts";
import { applyAuthoringValidator, listAuthoringFactories, listAuthoringValidators, previewAuthoringValidator, runAuthoringValidatorFixtures } from "./authoring.ts";
import { assertSafeRuntimeHost, createRuntimeAuthToken, isAuthorizedRuntimeRequest, usableRuntimeAuthToken } from "./auth.ts";
import { listProjects } from "./project-summary.ts";
import { ApiPathPrefix, ApiRoute, ProjectIndexResponseMode, UrlSearchParam, diagnostic, diagnosticCodes, diagnosticsFailure, json, validateRuntimeAuth, validateMethod, type RuntimeError } from "./routes.ts";
import { localPipeEndpoint, serveLocalProtocolPipe, type LocalProtocolPipeServer } from "./local-protocol.ts";
import { acquireProjectWorkerLease, stopService } from "./service.ts";
import { createValidatorGraphRuntime } from "./validator-graph-runtime.ts";
import { createProjectTypesRuntime } from "./project-types-runtime.ts";
import { createTypeProducerRuntime, defaultTsconfigPath } from "./type-producer/runtime.ts";
import { LiveTypeProducerProvider } from "./type-producer/live-provider.ts";
import { createRuntimeStateManager } from "./state-manager.ts";
import { ProjectFileLanguage, setLiveTypeFactsProviderFactory, setProjectAstFactsProviderFactory, resolveProducerStatuses, normalizeProducerStatusesForProject } from "@opencanon/core";
import { createCliAstFactsProvider, engineProjectAstFactsProvider } from "./ast-facts-provider.ts";
import { createProjectObservabilityExporter } from "./observability.ts";
import {
  askProjectContext,
  listProjectContextChunks,
  projectContextBacklinks,
  projectContextCoverage,
  searchProjectContext,
} from "./project-context.ts";
import {
  activeTaskLeaseSummaries,
  claimTaskLease,
  listGlobalCanonEvents,
  listWorktreeOverview,
  mergeCanonEvents,
  releaseTaskLease,
  requireTaskLeaseOwner,
  ensureWorktreeCoordinationSignal,
  worktreeOverviewSignature,
  writeGlobalCanonEvent,
} from "./worktree-coordination.ts";

const FeedbackHostValue = {
  Manual: "manual",
  Codex: "codex",
  Claude: "claude",
  OpenCode: "opencode",
} as const;

const FixModeInput = {
  All: "all",
  Safe: "safe",
  Suggested: "suggested",
} as const;

const ChangeEventType = {
  Started: ChangeLifecycleEventType.Started,
  Review: ChangeLifecycleEventType.Review,
  Blocked: ChangeLifecycleEventType.Blocked,
  Ready: ChangeLifecycleEventType.Ready,
  Closed: ChangeLifecycleEventType.Closed,
  CheckStarted: ChangeCheckEventType.Started,
  CheckPassed: ChangeCheckEventType.Passed,
  CheckFailed: ChangeCheckEventType.Failed,
  TaskClaimed: ChangeTaskEventType.Claimed,
  TaskStarted: ChangeTaskEventType.Started,
  TaskReview: ChangeTaskEventType.Review,
  TaskBlocked: ChangeTaskEventType.Blocked,
  TaskReady: ChangeTaskEventType.Ready,
  TaskClosed: ChangeTaskEventType.Closed,
  TaskCheckStarted: ChangeTaskEventType.CheckStarted,
  TaskCheckPassed: ChangeTaskEventType.CheckPassed,
  TaskCheckFailed: ChangeTaskEventType.CheckFailed,
} as const;
type ChangeEventType = (typeof ChangeEventType)[keyof typeof ChangeEventType];
const changeEventTypes = new Set<string>(Object.values(ChangeEventType));

const FindingSeverityValue = {
  Error: "error",
} as const;

const RuntimeHealthStatusValue = {
  Failed: "failed",
  Indexing: "indexing",
  Ready: "ready",
  Stale: "stale",
} as const;

const DefinitionHistoryKindValue = {
  Convention: "convention",
  Area: "area",
  Spec: "spec",
  Change: "change",
} as const satisfies Record<string, DefinitionHistoryKind>;

const execCommand = promisify(execShell);
const CheckCommandTimeoutMs = 2 * 60 * 1000;
const CheckCommandMaxBuffer = 1024 * 1024;
const CoordinationRefreshDebounceMs = 150;
const MaxQueuedWatchRebuilds = 32;

export type RuntimeServerOptions = {
  cwd?: string;
  host?: string;
  port?: number;
  pipeEndpoint?: string;
  statePath?: string;
  authToken?: string;
  allowRemote?: boolean;
  idleTimeoutMs?: number;
  onIdle?: () => void | Promise<void>;
};

export type RuntimeServer = {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  stop(): Promise<void>;
};

const RuntimeEnv = {
  LeaseId: "OPENCANON_RUNTIME_LEASE_ID",
  RegistryPath: "OPENCANON_SERVICE_REGISTRY_PATH",
  PipeEndpoint: "OPENCANON_RUNTIME_PIPE_ENDPOINT",
} as const;

export async function startOpenCanonRuntime(options: RuntimeServerOptions = {}): Promise<RuntimeServer> {
  const cwd = options.cwd ?? process.cwd();
  const rootDir = resolveRootDir(cwd);
  const host = options.host ?? "127.0.0.1";
  assertSafeRuntimeHost(host, options.allowRemote);
  const authToken = usableRuntimeAuthToken(options.authToken) ?? usableRuntimeAuthToken(process.env.OPENCANON_RUNTIME_TOKEN) ?? createRuntimeAuthToken();
  const port = options.port ?? 4767;
  const processIdentity = {
    kind: "runtime" as const,
    pid: process.pid,
    leaseId: process.env[RuntimeEnv.LeaseId]?.trim() || `runtime-${process.pid}`,
  };
  let paths = createPaths(rootDir);
  const configDiagnostics = validateConfig(paths);
  if (configDiagnostics.length > 0) {
    throw new Error(`Invalid OpenCanon config:\n${configDiagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`);
  }
  const prerequisites = assertRuntimePrerequisites();
  const workerLease = acquireProjectWorkerLease({
    rootDir,
    leaseId: processIdentity.leaseId,
    registryPath: process.env[RuntimeEnv.RegistryPath]?.trim() || undefined,
  });
  const storeResource = resource({
    init() {
      return createProjectStore({ rootDir, paths, engine: prerequisites.engine, statePath: options.statePath });
    },
    dispose: (store) => store.close(),
  });
  let store = await storeResource.get();
  const tracer = new SimpleTracer(new NoopLogger(), {
    clock: new SystemClock(),
    ids: new CryptoIdGenerator(),
    exporters: [
      createProjectObservabilityExporter({
        writeObservabilityRecords(records) {
          store.writeObservabilityRecords(records);
        },
      }),
    ],
    resource: serviceTelemetryResource({
      serviceName: "opencanon-runtime",
      attributes: {
        "opencanon.root": rootDir,
      },
    }),
  });
  const events = createEventBroadcaster();
  let currentWorkerJob: RuntimeWorkerJob | undefined;
  let lastWorkerJob: RuntimeWorkerJob | undefined;
  const projectTypesRuntime = createProjectTypesRuntime({
    rootDir,
    paths: () => paths,
    events,
  });
  projectTypesRuntime.generateNow("Project authoring types generated on runtime startup.");
  // Runtime-owned live type-producer: one worker manager per project runtime,
  // lazy-spawned on first typed query and idle-killed afterward. Installed as
  // core's live provider factory; validation uses it only when the selected
  // producer policy asks for the interactive TypeScript worker.
  // Opt-out: OPENCANON_TYPED_PRODUCER=off (or 0/false) disables the live producer
  // entirely. Interactive typed rules then report the TypeScript producer as
  // not implemented for this process instead of silently changing source.
  // Default is on (lazy, idle-timed).
  const typedProducerEnv = (process.env.OPENCANON_TYPED_PRODUCER ?? "").trim().toLowerCase();
  const typedProducerDisabled = typedProducerEnv === "off" || typedProducerEnv === "0" || typedProducerEnv === "false";
  const tsconfigPath = defaultTsconfigPath(rootDir);
  const typeProducerRuntime = tsconfigPath && !typedProducerDisabled
    ? createTypeProducerRuntime({ rootDir, tsconfigPath })
    : undefined;
  let engineAstProvider: ReturnType<typeof engineProjectAstFactsProvider> | undefined = engineProjectAstFactsProvider(store.project);
  const fixtureAst = createCliAstFactsProvider();
  // AST facts provider (oxc engine) for TypeScript facts. The boot snapshot needs
  // this before validation builds import facts; the live type producer remains
  // delayed because it can spawn a heavy ts.Program.
  setProjectAstFactsProviderFactory((queryRoot) => (queryRoot === rootDir ? engineAstProvider : fixtureAst.factory(queryRoot)));
  // NOTE: the live provider is installed AFTER the server is listening (below),
  // never before the boot snapshot. The producer's cold ts.Program build (seconds
  // on a large repo) must not sit on the runtime-readiness critical path — doing so
  // blows past the health-probe window and the service declares the runtime dead.
  // The boot snapshot runs without typed facts; the first post-ready validation
  // warms the producer.
  let snapshot: RuntimeSnapshot;
  try {
    snapshot = await tracer.span("runtime.snapshot.boot", { kind: SpanKind.TASK, attributes: { phase: "boot" } }, async (span) => {
      const next = await buildRuntimeSnapshot({
        cwd: rootDir,
        engine: prerequisites.engine,
        store,
        semanticEmbedding: DefaultSemanticEmbeddingConfig,
        semanticIndexMode: "reuse",
      });
      span.setOutput({
        files: next.files.length,
        findings: next.findings.length,
        validators: next.validators.length,
      });
      return withProcessIdentity(next);
    });
  } catch (error) {
    setProjectAstFactsProviderFactory(undefined);
    fixtureAst.dispose();
    projectTypesRuntime.stop();
    await typeProducerRuntime?.stop();
    events.close();
    await tracer.shutdown().catch(() => undefined);
    await storeResource.dispose();
    workerLease.release();
    throw error;
  }
  let stopped = false;
  let validatorGraphRuntime: ReturnType<typeof createValidatorGraphRuntime> | undefined;
  const stateManager = createRuntimeStateManager({
    initialSnapshot: snapshot,
    initialProjectInventory: listProjectInventory(rootDir),
    maxQueuedRebuilds: MaxQueuedWatchRebuilds,
    isStopped: () => stopped,
    rebuildNow: rebuildAndPublishNow,
    readProjectInventory: () => listProjectInventory(rootDir),
    onRebuildError(error) {
      events.broadcast(streamErrorEvent(formatOpenCanonDiagnostics(getOpenCanonErrorDiagnostics(runtimeSnapshotFailure(error).error))));
    },
  });
  validatorGraphRuntime = createValidatorGraphRuntime({
    rootDir,
    paths: () => paths,
    events,
    initialDependencyFiles: stateManager.currentSnapshot().health.validatorGraph?.dependencyFiles,
    rebuildAndPublish: stateManager.rebuildAndPublish,
    isStopped: () => stopped,
  });
  let coordinationDirectoryWatcher: FSWatcher | undefined;
  let coordinationSignalWatcher: FSWatcher | undefined;
  let coordinationRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let startupRebuildTimer: ReturnType<typeof setTimeout> | undefined;
  let coordinationSignature = "";
  const idleTimeoutMs = options.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  // Producer warming->ready refresh state. `latestReadyGeneration` is the newest
  // generation observed; a debounced refresh fires after quiescence and the
  // generation-guard drops it if a newer generation arrived meanwhile.
  const ProducerReadyDebounceMs = 300;
  let producerReadyDebounce: ReturnType<typeof setTimeout> | undefined;
  let latestReadyGeneration = 0;

  let server: { port: number; stop(force?: boolean): Promise<void> } | undefined;
  let pipeServer: LocalProtocolPipeServer | undefined;
  try {
    startStoreWatcher();
    startCoordinationWatcher();
    stateManager.setSnapshot(withProcessIdentity(refreshSnapshotRefreshStatus(stateManager.currentSnapshot(), store)));
    // Install the live type producer now that boot is essentially done — it spawns
    // lazily on the first typed query (post-ready), never on the readiness path.
    if (typeProducerRuntime) {
      const liveProvider = new LiveTypeProducerProvider(typeProducerRuntime);
      setLiveTypeFactsProviderFactory((queryRoot, language) => (queryRoot === rootDir && language === ProjectFileLanguage.TypeScript ? liveProvider : null));
      // Defect #3: when the lazy producer warms (warming->ready, generation
      // advance), refresh the snapshot so baked skipped(warming) outcomes flip to
      // ran. Debounce rapid transitions; a generation-guard drops a completion
      // when a newer generation has since arrived (no flapping noise). Reuses the
      // existing rebuildAndPublish path so only validators whose producer
      // availability changed get re-run on the next snapshot build.
      typeProducerRuntime.onReady((generation) => scheduleProducerReadyRefresh(generation));
    }
    const routeRequest = async (request: Request): Promise<Response> => {
      resetIdleTimer();
      const url = new URL(request.url);
      return tracer.span(
        "runtime.request",
        { kind: SpanKind.SERVER, attributes: { method: request.method, path: url.pathname } },
        async (span) => {
          const response = await routeRequestInner(request, url);
          span.setOutput({ status: response.status });
          return response;
        },
      );
    };
    const routeRequestInner = async (request: Request, url: URL): Promise<Response> => {
      const methodValidation = validateMethod(url.pathname, request.method);
      if (!methodValidation.ok) return json(methodValidation.error, 405);
      const authValidation = validateRuntimeAuth(request, url, authToken);
      if (!authValidation.ok) return json(authValidation.error, 401);
      if (url.pathname === ApiRoute.Health) {
          // Public liveness, but the detailed health (engine/schema versions, graph hash,
          // refresh state, counts) is only disclosed to authorized callers.
          if (!isAuthorizedRuntimeRequest(request, url, authToken)) {
            return json({ ok: true, data: { status: "ok" } });
          }
          const snapshot = await refreshCurrentSnapshot();
          return json({ ok: true, data: snapshot.health });
        }
        if (url.pathname === ApiRoute.State) {
          const snapshot = await refreshCurrentSnapshot();
          return json({ ok: true, data: snapshot.state });
        }
        if (url.pathname === ApiRoute.Snapshot) {
          const snapshot = await refreshCurrentSnapshot();
          return json({ ok: true, data: snapshot });
        }
        if (url.pathname === ApiRoute.ProjectSummary) {
          const snapshot = await refreshCurrentSnapshot();
          return json({ ok: true, data: buildProjectSummary({ rootDir, snapshot, store }) });
        }
        if (url.pathname === ApiRoute.ContextStatus) {
          return json({ ok: true, data: store.readSemanticIndexStatus({ indexId: "project" }) });
        }
        if (url.pathname === ApiRoute.ContextChunks) {
          const snapshot = await refreshCurrentSnapshot();
          const pathFilter = validateOptionalRelativePaths(url.searchParams.getAll(UrlSearchParam.Path));
          if (!pathFilter.ok) return json(pathFilter.error, 400);
          return json({
            ok: true,
            data: listProjectContextChunks({
              store,
              snapshot,
              paths: pathFilter.paths,
              definitionIds: url.searchParams.getAll(UrlSearchParam.Definition),
              limit: Math.min(500, numberParam(url, UrlSearchParam.Limit, 100)),
              offset: nonNegativeNumberParam(url, UrlSearchParam.Offset, 0),
            }),
          });
        }
        if (url.pathname === ApiRoute.ContextSearch) {
          return await tracer.span("project-context.search", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, async (span) => {
            const snapshot = await refreshCurrentSnapshot();
            const query = (url.searchParams.get(UrlSearchParam.Query) ?? "").trim();
            const limit = Math.min(100, numberParam(url, UrlSearchParam.Limit, 20));
            const pathFilter = validateOptionalRelativePaths(url.searchParams.getAll(UrlSearchParam.Path));
            if (!pathFilter.ok) return json(pathFilter.error, 400);
            try {
              const result = searchProjectContext({
                store,
                snapshot,
                query: { query, paths: pathFilter.paths, limit },
                semanticEmbedding: paths.semanticEmbedding,
              });
              span.setOutput({ results: result.results.length, indexed: Boolean(result.index) });
              return json({ ok: true, data: result });
            } catch (error) {
              return json(
                diagnosticsFailure([
                  createOpenCanonDiagnostic({
                    code: diagnosticCodes.inferenceError,
                    message: `Could not search Project Context: ${error instanceof Error ? error.message : String(error)}`,
                  }),
                ], diagnosticCodes.inferenceError),
                500,
              );
            }
          });
        }
        if (url.pathname === ApiRoute.ContextAsk) {
          return await tracer.span("project-context.ask", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, async (span) => {
            const snapshot = await refreshCurrentSnapshot();
            const question = (url.searchParams.get(UrlSearchParam.Query) ?? "").trim();
            if (!question) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "Project Context Ask requires a query."), 400);
            try {
              const result = askProjectContext({ store, snapshot, question, semanticEmbedding: paths.semanticEmbedding });
              span.setOutput({ evidence: result.evidence.length, indexed: Boolean(result.index) });
              return json({ ok: true, data: result });
            } catch (error) {
              return json(
                diagnosticsFailure([
                  createOpenCanonDiagnostic({
                    code: diagnosticCodes.inferenceError,
                    message: `Could not ask Project Context: ${error instanceof Error ? error.message : String(error)}`,
                  }),
                ], diagnosticCodes.inferenceError),
                500,
              );
            }
          });
        }
        if (url.pathname === ApiRoute.ContextCoverage) {
          const snapshot = await refreshCurrentSnapshot();
          return json({ ok: true, data: projectContextCoverage({ store, snapshot }) });
        }
        if (url.pathname === ApiRoute.ContextPacket) {
          const snapshot = await refreshCurrentSnapshot();
          const pathFilter = validateOptionalRelativePaths(url.searchParams.getAll(UrlSearchParam.File));
          if (!pathFilter.ok) return json(pathFilter.error, 400);
          const changeIds = url.searchParams.getAll(UrlSearchParam.ChangeId).map((id) => id.trim()).filter(Boolean);
          const missingChangeId = changeIds.find((id) => !snapshot.changes.some((change) => change.id === id));
          if (missingChangeId) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `Unknown change id: ${missingChangeId}.`), 404);
          const project = await loadProjectContext(rootDir);
          const doctor = buildDoctorReport({
            paths: project.paths,
            areas: project.areas,
            changes: project.changes,
            conventions: project.conventions,
            specs: project.specs,
            validators: project.validators,
            producerStatuses: resolveProducerStatuses(rootDir),
            semanticIndex: store.readSemanticIndexStatus({ indexId: "project" }).index,
          });
          return json({
            ok: true,
            data: buildContextPacket({
              rootDir,
              mode: (url.searchParams.get(UrlSearchParam.Mode) ?? "agent-context").trim() || "agent-context",
              snapshot,
              doctorStatus: doctor.status,
              files: pathFilter.paths,
              changeIds,
              events: listChangeEvents(rootDir, store, { limit: Math.min(100, numberParam(url, UrlSearchParam.Limit, 25)) }),
              limit: Math.min(100, numberParam(url, UrlSearchParam.Limit, 25)),
            }),
          });
        }
        if (url.pathname === ApiRoute.ContextBacklinks) {
          const snapshot = await refreshCurrentSnapshot();
          const query = (url.searchParams.get(UrlSearchParam.Query) ?? url.searchParams.get(UrlSearchParam.Id) ?? url.searchParams.get(UrlSearchParam.Path) ?? "").trim();
          if (!query) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "Project Context backlinks requires query, id, or path."), 400);
          return json({ ok: true, data: projectContextBacklinks({ snapshot, query }) });
        }
        if (url.pathname === ApiRoute.Changes) {
          const snapshot = await refreshCurrentSnapshot();
          return json({ ok: true, data: snapshot.changes });
        }
        if (url.pathname === ApiRoute.ChangeReady) {
          const project = await loadProjectContext(rootDir);
          return json({ ok: true, data: deriveChangeWorkQueue(project.changes, listRuntimeEvents(rootDir, store, 500), { leases: activeTaskLeaseSummaries(rootDir) }) });
        }
        if (url.pathname === ApiRoute.Worktrees) {
          return json({ ok: true, data: listWorktreeOverview(rootDir) });
        }
        if (url.pathname === ApiRoute.ChangeChecksRun) {
          const project = await loadProjectContext(rootDir);
          const parsed = parseRunChangeCheckRequest(await readJsonBody(request), project.changes);
          if (!parsed.ok) return json(diagnosticsFailure(parsed.diagnostics), 400);
          const results: RunChangeCheckResult[] = [];
          const checkEvents: CanonEvent[] = [];
          let snapshot = stateManager.currentSnapshot();
          for (const check of parsed.checks) {
            const started = createChangeCheckEvent({
              changeId: parsed.change.id,
              taskId: parsed.task?.id,
              checkId: check.id,
              type: parsed.task ? ChangeEventType.TaskCheckStarted : ChangeEventType.CheckStarted,
              actor: parsed.actor,
              summary: parsed.task ? `Task ${parsed.task.id} check ${check.id} started.` : `Check ${check.id} started.`,
            });
            writeRuntimeEvent(rootDir, store, started);
            checkEvents.push(started);
            snapshot = await stateManager.rebuildAndPublish(started.summary);
            const result = await tracer.span(
              "change.check.run",
              {
                kind: SpanKind.TASK,
                attributes: {
                  changeId: parsed.change.id,
                  taskId: parsed.task?.id,
                  checkId: check.id,
                  checkKind: check.kind,
                },
              },
              async (span) => {
                const checkResult = await runChangeCheck(rootDir, project, parsed.change, check, store, parsed.task);
                span.setOutput({ status: checkResult.status });
                return checkResult;
              },
            );
            results.push(result);
            const finished = createChangeCheckEvent({
              changeId: parsed.change.id,
              taskId: parsed.task?.id,
              checkId: check.id,
              type: parsed.task
                ? (result.status === "passed" ? ChangeEventType.TaskCheckPassed : ChangeEventType.TaskCheckFailed)
                : (result.status === "passed" ? ChangeEventType.CheckPassed : ChangeEventType.CheckFailed),
              actor: parsed.actor,
              summary: result.summary,
            });
            writeRuntimeEvent(rootDir, store, finished);
            checkEvents.push(finished);
            snapshot = await stateManager.rebuildAndPublish(finished.summary);
          }
          const lastEvent = checkEvents[checkEvents.length - 1];
          return json({ ok: true, data: { result: results[0], results, event: lastEvent, events: checkEvents, changes: snapshot.changes } });
        }
        if (url.pathname === ApiRoute.ChangeEvents) {
          if (request.method === "GET") {
            const changeId = url.searchParams.get(UrlSearchParam.ChangeId) ?? undefined;
            const taskId = url.searchParams.get(UrlSearchParam.TaskId) ?? undefined;
            const checkId = url.searchParams.get(UrlSearchParam.CheckId) ?? undefined;
            return json({ ok: true, data: listChangeEvents(rootDir, store, { changeId, taskId, checkId, limit: numberParam(url, UrlSearchParam.Limit, 50) }) });
          }
          const project = await loadProjectContext(rootDir);
          const parsed = parseChangeEventRequest(await readJsonBody(request), project.changes);
          if (!parsed.ok) return json(diagnosticsFailure(parsed.diagnostics), 400);
          const ownership = applyTaskOwnershipEvent(rootDir, parsed.event);
          if (!ownership.ok) return json(diagnosticsFailure(ownership.diagnostics), ownership.status);
          writeRuntimeEvent(rootDir, store, ownership.event);
          const snapshot = await stateManager.rebuildAndPublish(ownership.event.summary);
          return json({ ok: true, data: { event: ownership.event, changes: snapshot.changes } });
        }
        if (url.pathname === ApiRoute.CanonRelated) {
          const snapshot = await refreshCurrentSnapshot();
          const body = request.method === "POST" ? await readJsonBody(request) : {};
          const requestedFiles = request.method === "POST" ? stringArrayBodyValue(body.files) : url.searchParams.getAll(UrlSearchParam.File);
          const safeFiles = validateOptionalRelativePaths(requestedFiles);
          if (!safeFiles.ok) return json(safeFiles.error, 400);
          const currentSnapshot = snapshot;
          const query = {
            files: safeFiles.paths,
            topics: request.method === "POST" ? stringArrayBodyValue(body.topics) : url.searchParams.getAll(UrlSearchParam.Topic).filter(Boolean),
            conventionIds: request.method === "POST" ? stringArrayBodyValue(body.conventionIds) : url.searchParams.getAll(UrlSearchParam.ConventionId).filter(Boolean),
            validatorIds: request.method === "POST" ? stringArrayBodyValue(body.validatorIds) : url.searchParams.getAll(UrlSearchParam.ValidatorId).filter(Boolean),
            findingIds: request.method === "POST" ? stringArrayBodyValue(body.findingIds) : url.searchParams.getAll(UrlSearchParam.FindingId).filter(Boolean),
          };
          const selectorError = validateRelatedSelectors(currentSnapshot, query);
          if (selectorError) return json(selectorError.error, selectorError.status);
          return json({
            ok: true,
            data: buildRelatedCanon({
              rootDir,
              paths,
              snapshot: currentSnapshot,
              query,
            }),
          });
        }
        if (url.pathname === ApiRoute.EventsStream) {
          return eventStream(events.connect(snapshotEvent(stateManager.currentSnapshot(), "Connected to runtime stream.")));
        }
        if (url.pathname === ApiRoute.Events)
          return json({
            ok: true,
            data: listRuntimeEvents(rootDir, store, numberParam(url, UrlSearchParam.Limit, 50)),
          });
        if (url.pathname === ApiRoute.Observability) {
          const traceId = url.searchParams.get(UrlSearchParam.TraceId)?.trim() || undefined;
          return json({
            ok: true,
            data: store.listObservabilityRecords({
              limit: numberParam(url, UrlSearchParam.Limit, 100),
              traceId,
            }),
          });
        }
        if (url.pathname === ApiRoute.CanonHistory) {
          return await canonHistoryFromRuntime(rootDir, url);
        }
        if (url.pathname === ApiRoute.GitHistory) {
          const safeFiles = validateRelativePaths(url.searchParams.getAll(UrlSearchParam.File));
          if (!safeFiles.ok) return json(safeFiles.error, 400);
          return json({
            ok: true,
            data: gitHistorySnapshot(rootDir, safeFiles.paths, numberParam(url, UrlSearchParam.Limit, 5)),
          });
        }
        if (url.pathname === ApiRoute.GitDiff) {
          const safeFile = validateRelativePath(url.searchParams.get(UrlSearchParam.File) ?? "", { allowEmpty: false });
          if (!safeFile.ok) return json(safeFile.error, 400);
          const safeCommit = validateCommitHash(url.searchParams.get(UrlSearchParam.Commit) ?? "");
          if (!safeCommit.ok) return json(safeCommit.error, 400);
          return json({
            ok: true,
            data: gitDiffSnapshot(rootDir, safeFile.path, safeCommit.commit),
          });
        }
        if (url.pathname === ApiRoute.Producers) {
          // Live producer status (the runtime owns it). resolveProducerStatuses
          // consults the installed live factory; the response is the binary,
          // first-class producer-state surface for `project status` + CI gates.
          if (url.searchParams.get("warm") === "1") await typeProducerRuntime?.warm();
          const producers = resolveProducerStatuses(rootDir);
          try {
            const project = await loadProjectContext(rootDir);
            return json({ ok: true, data: { producers: normalizeProducerStatusesForProject({ paths: project.paths, validators: project.validators, producers }) } });
          } catch {
            return json({ ok: true, data: { producers: normalizeProducerStatusesForProject({ paths, producers }) } });
          }
        }
        if (url.pathname === ApiRoute.Doctor) {
          return tracer.span("doctor.report", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, async (span) => {
            if (url.searchParams.get("warm") === "1") await typeProducerRuntime?.warm();
            const project = await loadProjectContext(rootDir);
            const report = buildDoctorReport({
              paths: project.paths,
              areas: project.areas,
              changes: project.changes,
              conventions: project.conventions,
              specs: project.specs,
              validators: project.validators,
              producerStatuses: resolveProducerStatuses(rootDir),
              semanticIndex: store.readSemanticIndexStatus({ indexId: "project" }).index,
            });
            span.setOutput({ status: report.status, checks: report.checks.length });
            return json({
              ok: true,
              data: report,
            });
          });
        }
        if (url.pathname === ApiRoute.Validate && request.method === "POST") {
          return await tracer.span("validation.run", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, () => validateFromRuntime(rootDir, request));
        }
        if (url.pathname === ApiRoute.Feedback && request.method === "POST") {
          return await tracer.span("feedback.run", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, () => feedbackFromRuntime(rootDir, request));
        }
        if (url.pathname === ApiRoute.HookFeedback && request.method === "POST") {
          return await tracer.span("feedback.hook", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, async () =>
            json({ ok: true, data: await hookFeedbackFromRuntime(rootDir, request) }),
          );
        }
        if (url.pathname === ApiRoute.Index && request.method === "POST") {
          const body = await readJsonBody(request);
          const snapshot = await stateManager.rebuildAndPublish("Manual reindex completed.");
          if (body.response === ProjectIndexResponseMode.SemanticIndex) {
            return json({ ok: true, data: { semanticIndex: snapshot.state.semanticIndex ?? snapshot.semanticIndex ?? null } });
          }
          return json({ ok: true, data: snapshot });
        }
        if (url.pathname === ApiRoute.Settings) {
          if (request.method === "GET") return json({ ok: true, data: readProjectSettings(rootDir) });
          const result = writeProjectSettings(rootDir, await readJsonBody(request));
          if (!result.ok) return json(diagnosticsFailure(result.diagnostics), 400);
          paths = createPaths(rootDir);
          await restartStore();
          projectTypesRuntime.generateNow("Project authoring types regenerated after settings changed.");
          await stateManager.rebuildAndPublish("Project settings saved.");
          return json({ ok: true, data: result.settings });
        }
        if (url.pathname === ApiRoute.AuthoringFactories) {
          return json({ ok: true, data: listAuthoringFactories() });
        }
        if (url.pathname === ApiRoute.AuthoringValidators) {
          return json({ ok: true, data: await listAuthoringValidators(rootDir) });
        }
        if (url.pathname === ApiRoute.AuthoringValidatorsPreview && request.method === "POST") {
          const result = previewAuthoringValidator(rootDir, await readJsonBody(request));
          if (!result.ok) return json(diagnosticsFailure(result.diagnostics), 400);
          return json({ ok: true, data: result.preview });
        }
        if (url.pathname === ApiRoute.AuthoringValidatorsRunFixtures && request.method === "POST") {
          const result = await runAuthoringValidatorFixtures(rootDir, await readJsonBody(request));
          if (!result.ok) return json(diagnosticsFailure(result.diagnostics), 400);
          return json({ ok: true, data: result.run });
        }
        if (url.pathname === ApiRoute.AuthoringValidatorsApply && request.method === "POST") {
          const result = await applyAuthoringValidator(rootDir, await readJsonBody(request));
          if (!result.ok) return json(diagnosticsFailure(result.diagnostics), 400);
          await stateManager.rebuildAndPublish("Definition authoring applied a convention.");
          return json({ ok: true, data: result.result });
        }
        if (url.pathname === ApiRoute.ServiceProjects) {
          const snapshot = await refreshCurrentSnapshot();
          return json({ ok: true, data: await listProjects(rootDir, snapshot) });
        }
        if (url.pathname === ApiRoute.FsTree) {
          const snapshot = await refreshCurrentSnapshot();
          const requested = url.searchParams.get(UrlSearchParam.Path) ?? "";
          const safe = validateRelativePath(requested, { allowEmpty: true });
          if (!safe.ok) return json(safe.error, 400);
          const scope = treeScopeParam(url);
          const query = url.searchParams.get(UrlSearchParam.Query) ?? "";
          const showDotEntries = url.searchParams.get(UrlSearchParam.Dot) !== "0";
          const withFindingsOnly = url.searchParams.get(UrlSearchParam.WithFindings) === "1";
          let sourceFiles = snapshot.files;
          if (scope === TreeScope.All) {
            const projectInventory = stateManager.currentProjectInventory();
            if (!projectInventory.ok) return json(projectInventory.error, 500);
            sourceFiles = projectInventory.files;
          }
          return json({
            ok: true,
            data: buildTreeResponse(safe.path, sourceFiles, snapshot, { query, showDotEntries, withFindingsOnly }),
          });
        }
        if (url.pathname === ApiRoute.FsFile) {
          const requested = url.searchParams.get(UrlSearchParam.Path) ?? "";
          const safe = validateRelativePath(requested, { allowEmpty: false });
          if (!safe.ok) return json(safe.error, 400);
          return await tracer.span("fs.file.read", { kind: SpanKind.TASK, attributes: { path: safe.path } }, () => readFileResponse(rootDir, safe.path));
        }
        if (url.pathname === ApiRoute.Findings) {
          const snapshot = await refreshCurrentSnapshot();
          const requested = url.searchParams.get(UrlSearchParam.File);
          if (!requested) {
            return json({ ok: true, data: snapshot.findings });
          }
          const safe = validateRelativePath(requested, { allowEmpty: false });
          if (!safe.ok) return json(safe.error, 400);
          return json({
            ok: true,
            data: snapshot.findings.filter((f) => f.file === safe.path),
          });
        }
        if (url.pathname === ApiRoute.GatePending) {
          return json({ ok: true, data: loadPendingCommitGates(createPaths(rootDir)) });
        }
        if (url.pathname === ApiRoute.GateApprove && request.method === "POST") {
          return await tracer.span("gate.approve", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, () => approveCommitGateFromRuntime(rootDir, request));
        }
        if (url.pathname.startsWith(ApiPathPrefix)) {
          return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `Unknown runtime route: ${url.pathname}.`), 404);
        }
        return new Response("OpenCanon project runtime exposes /api/* only.", { status: 404 });
    };
    server = await serveRuntime({ host, port, routeRequest });
    const pipeEndpoint =
      options.pipeEndpoint ??
      process.env[RuntimeEnv.PipeEndpoint] ??
      localPipeEndpoint({ scope: "runtime", key: `${rootDir}:${options.statePath ?? ""}:${process.pid}:${port}` });
    pipeServer = await serveLocalProtocolPipe({
      endpoint: pipeEndpoint,
      routeRequest,
      host: "opencanon.runtime",
      maxFrameBytes: MaxRequestBodyBytes,
    });
    startupRebuildTimer = setTimeout(() => {
      startupRebuildTimer = undefined;
      stateManager.scheduleRebuild("Project Context refreshed after startup.");
    }, 0);
    if (typeof startupRebuildTimer === "object" && "unref" in startupRebuildTimer) {
      (startupRebuildTimer as { unref: () => void }).unref();
    }
    resetIdleTimer();
  } catch (error) {
    if (startupRebuildTimer) clearTimeout(startupRebuildTimer);
    startupRebuildTimer = undefined;
    await pipeServer?.stop(true).catch(() => undefined);
    await server?.stop(true).catch(() => undefined);
    stopStoreWatcher();
    projectTypesRuntime.stop();
    setLiveTypeFactsProviderFactory(undefined);
    setProjectAstFactsProviderFactory(undefined);
    fixtureAst.dispose();
    await typeProducerRuntime?.stop();
    events.close();
    await tracer.shutdown().catch(() => undefined);
    await storeResource.dispose();
    workerLease.release();
    throw error;
  }

  function scheduleProducerReadyRefresh(generation: number): void {
    if (stopped) return;
    if (generation > latestReadyGeneration) latestReadyGeneration = generation;
    if (producerReadyDebounce) clearTimeout(producerReadyDebounce);
    producerReadyDebounce = setTimeout(() => {
      producerReadyDebounce = undefined;
      const scheduledGeneration = latestReadyGeneration;
      // Generation-guard: rebuild, then drop the publish if a newer generation
      // arrived during the debounce window (a rebuild for it is/was scheduled).
      void scheduleWatchRebuildForProducer(scheduledGeneration);
    }, ProducerReadyDebounceMs);
    if (typeof producerReadyDebounce === "object" && "unref" in producerReadyDebounce) {
      (producerReadyDebounce as { unref: () => void }).unref();
    }
  }

  async function scheduleWatchRebuildForProducer(generation: number): Promise<void> {
    if (stopped || generation < latestReadyGeneration) return;
    stateManager.scheduleRebuild(`Type producer ready (generation ${generation}); re-running producer-dependent validators.`);
  }

  async function refreshCurrentSnapshot(): Promise<RuntimeSnapshot> {
    if (!validatorGraphRuntime) return stateManager.currentSnapshot();
    const refreshed = await validatorGraphRuntime.refreshIfChanged(stateManager.currentSnapshot());
    return stateManager.setSnapshot(withProcessIdentity(refreshed));
  }

  function startStoreWatcher(): void {
    try {
      store.project.startWatcher({ debounceMs: 250, bufferCapacity: 128 }, (batch) => {
        if (stopped) return;
        const summary = watcherBatchSummary(batch);
        projectTypesRuntime.scheduleForFiles(batch.paths, "Project authoring types updated after indexed files changed.");
        if (summary) stateManager.scheduleRebuild(summary);
      });
      stateManager.setSnapshot(refreshSnapshotRefreshStatus(stateManager.currentSnapshot(), store));
    } catch (error) {
      const reason = `File watching is unavailable; manual refresh is required: ${errorMessage(error)}`;
      stateManager.setSnapshot(refreshSnapshotRefreshStatus(stateManager.currentSnapshot(), store, reason));
      events.broadcast(indexingEvent(reason, {
        phase: "file-discovery",
        label: "Project refresh is stale",
        indeterminate: false,
      }));
    }
  }

  function stopStoreWatcher(): void {
    store.project.stopWatcher();
  }

  function startCoordinationWatcher(): void {
    try {
      const signalPath = ensureWorktreeCoordinationSignal();
      const signalDir = path.dirname(signalPath);
      mkdirSync(signalDir, { recursive: true });
      coordinationSignature = currentCoordinationSignature();
      coordinationDirectoryWatcher = watch(signalDir, (eventType, filename) => {
        if (stopped) return;
        const changedName = typeof filename === "string" ? filename : undefined;
        const signalName = path.basename(signalPath);
        if (changedName && changedName !== signalName) return;
        startCoordinationSignalWatcher(signalPath);
        scheduleCoordinationRefresh(eventType);
      });
      if (typeof coordinationDirectoryWatcher === "object" && "unref" in coordinationDirectoryWatcher) coordinationDirectoryWatcher.unref();
      startCoordinationSignalWatcher(signalPath);
      scheduleCoordinationRefresh("startup");
    } catch (error) {
      events.broadcast(streamErrorEvent(`Active work updates are unavailable: ${errorMessage(error)}`));
    }
  }

  function startCoordinationSignalWatcher(signalPath: string): void {
    if (coordinationSignalWatcher || !existsSync(signalPath)) return;
    try {
      coordinationSignalWatcher = watch(signalPath, (eventType) => {
        if (stopped) return;
        if (eventType === "rename") {
          coordinationSignalWatcher?.close();
          coordinationSignalWatcher = undefined;
          startCoordinationSignalWatcher(signalPath);
        }
        scheduleCoordinationRefresh(eventType);
      });
      if (typeof coordinationSignalWatcher === "object" && "unref" in coordinationSignalWatcher) coordinationSignalWatcher.unref();
    } catch {
      coordinationSignalWatcher = undefined;
    }
  }

  function scheduleCoordinationRefresh(_eventType: string): void {
    if (coordinationRefreshTimer) clearTimeout(coordinationRefreshTimer);
    coordinationRefreshTimer = setTimeout(() => {
      coordinationRefreshTimer = undefined;
      if (stopped) return;
      const nextSignature = currentCoordinationSignature();
      if (nextSignature === coordinationSignature) return;
      coordinationSignature = nextSignature;
      stateManager.scheduleRebuild("Active work changed.");
    }, CoordinationRefreshDebounceMs);
    if (typeof coordinationRefreshTimer === "object" && "unref" in coordinationRefreshTimer) {
      (coordinationRefreshTimer as { unref: () => void }).unref();
    }
  }

  function currentCoordinationSignature(): string {
    try {
      return worktreeOverviewSignature(rootDir);
    } catch (error) {
      return `error:${errorMessage(error)}`;
    }
  }

  function stopCoordinationWatcher(): void {
    if (coordinationRefreshTimer) clearTimeout(coordinationRefreshTimer);
    coordinationRefreshTimer = undefined;
    coordinationSignalWatcher?.close();
    coordinationDirectoryWatcher?.close();
    coordinationSignalWatcher = undefined;
    coordinationDirectoryWatcher = undefined;
  }

  function resetIdleTimer(): void {
    if (!idleTimeoutMs || stopped) return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      void stopForIdle();
    }, idleTimeoutMs);
    if (typeof idleTimer === "object" && "unref" in idleTimer) {
      (idleTimer as { unref: () => void }).unref();
    }
  }

  async function stopForIdle(): Promise<void> {
    if (stopped) return;
    try {
      await options.onIdle?.();
    } finally {
      await stopInternal();
    }
  }

  async function restartStore(): Promise<void> {
    await stateManager.waitForIdle();
    stopStoreWatcher();
    await storeResource.dispose();
    store = await storeResource.get();
    engineAstProvider = engineProjectAstFactsProvider(store.project);
    startStoreWatcher();
  }

  async function rebuildAndPublishNow(summary: string): Promise<RuntimeSnapshot> {
    const jobId = beginWorkerJob({
      kind: RuntimeWorkerJobKindValue.SemanticIndex,
      label: "Refreshing Project Context",
      message: summary,
    });
    return tracer.span("runtime.snapshot.rebuild", { kind: SpanKind.TASK, attributes: { summary } }, async (span) => {
      try {
        updateWorkerJob(jobId, {
          label: "Discovering project files",
          message: "Indexing repository.",
        });
        events.broadcast(indexingEvent("Indexing repository.", {
          phase: "file-discovery",
          label: "Discovering project files",
          indeterminate: true,
        }));
        const next = await rebuildSnapshot({ cwd: rootDir, store });
        updateWorkerJob(jobId, {
          label: "Linking definitions and context",
          current: next.definitionGraph.nodes.length,
          total: next.definitionGraph.nodes.length,
          unit: "nodes",
          message: "Building project map and semantic index.",
        });
        events.broadcast(indexingEvent("Building project map and semantic index.", {
          phase: "product-graph",
          label: "Linking definitions and context",
          current: next.definitionGraph.nodes.length,
          total: next.definitionGraph.nodes.length,
          unit: "nodes",
        }));
        validatorGraphRuntime?.recordCurrentSourceSignature();
        store.writeEvent(indexedEvent(next, summary));
        finishWorkerJob(jobId, RuntimeWorkerJobStatusValue.Succeeded, {
          label: "Project context ready",
          current: next.files.length,
          total: next.files.length,
          unit: "files",
          message: summary,
        });
        const publishedSnapshot = withProcessIdentity(next);
        events.broadcast(indexingEvent(summary, {
          phase: "ready",
          label: "Project context ready",
          current: next.files.length,
          total: next.files.length,
          unit: "files",
        }));
        events.broadcast(snapshotEvent(publishedSnapshot, summary));
        span.setOutput({
          files: next.files.length,
          findings: next.findings.length,
          validators: next.validators.length,
        });
        return publishedSnapshot;
      } catch (error) {
        finishWorkerJob(jobId, RuntimeWorkerJobStatusValue.Failed, {
          label: "Project context refresh failed",
          message: errorMessage(error),
        });
        throw error;
      }
    });
  }

  async function rebuildSnapshot(input: { cwd: string; store: ProjectStore }): Promise<RuntimeSnapshot> {
    try {
      return withProcessIdentity(await buildRuntimeSnapshot({
        cwd: rootDir,
        engine: prerequisites.engine,
        store: input.store,
        semanticEmbedding: DefaultSemanticEmbeddingConfig,
      }));
    } catch (error) {
      throw new Error(formatOpenCanonDiagnostics(getOpenCanonErrorDiagnostics(runtimeSnapshotFailure(error).error)));
    }
  }

  function withProcessIdentity(next: RuntimeSnapshot): RuntimeSnapshot {
    const jobs = currentRuntimeJobs();
    const health = {
      ...next.health,
      status: runtimeHealthStatus(next, jobs),
      process: processIdentity,
      jobs,
    };
    return { ...next, health, state: { ...next.state, health } };
  }

  function runtimeHealthStatus(next: RuntimeSnapshot, jobs: RuntimeWorkerJob[]): RuntimeSnapshot["health"]["status"] {
    if (next.health.status === RuntimeHealthStatusValue.Failed) return RuntimeHealthStatusValue.Failed;
    if (jobs.some((job) => job.status === RuntimeWorkerJobStatusValue.Running || job.status === RuntimeWorkerJobStatusValue.Queued)) {
      return RuntimeHealthStatusValue.Indexing;
    }
    const semanticStatus = next.state.semanticIndex?.status ?? next.semanticIndex.status;
    if (semanticStatus === RuntimeHealthStatusValue.Failed) return RuntimeHealthStatusValue.Failed;
    if (semanticStatus === RuntimeHealthStatusValue.Indexing) return RuntimeHealthStatusValue.Indexing;
    if (semanticStatus === RuntimeHealthStatusValue.Stale) return RuntimeHealthStatusValue.Stale;
    if (next.health.refresh.status === ProjectRefreshStatusValue.Stale) return RuntimeHealthStatusValue.Stale;
    return RuntimeHealthStatusValue.Ready;
  }

  function currentRuntimeJobs(): RuntimeWorkerJob[] {
    const jobs = [currentWorkerJob, lastWorkerJob].filter((job): job is RuntimeWorkerJob => Boolean(job));
    return jobs.filter((job, index) => jobs.findIndex((item) => item.id === job.id) === index);
  }

  function beginWorkerJob(input: { kind: RuntimeWorkerJob["kind"]; label: string; message?: string }): string {
    const now = new Date().toISOString();
    const job: RuntimeWorkerJob = {
      id: `${input.kind}:${now}:${randomUUID()}`,
      kind: input.kind,
      status: RuntimeWorkerJobStatusValue.Running,
      label: input.label,
      startedAt: now,
      ...(input.message ? { message: input.message } : {}),
    };
    currentWorkerJob = job;
    lastWorkerJob = job;
    return job.id;
  }

  function updateWorkerJob(id: string, patch: Partial<Omit<RuntimeWorkerJob, "id" | "kind" | "status" | "startedAt">>): void {
    if (!currentWorkerJob || currentWorkerJob.id !== id) return;
    currentWorkerJob = { ...currentWorkerJob, ...patch };
    lastWorkerJob = currentWorkerJob;
  }

  function finishWorkerJob(
    id: string,
    status: typeof RuntimeWorkerJobStatusValue.Succeeded | typeof RuntimeWorkerJobStatusValue.Failed,
    patch: Partial<Omit<RuntimeWorkerJob, "id" | "kind" | "status" | "startedAt">> = {},
  ): void {
    if (!currentWorkerJob || currentWorkerJob.id !== id) return;
    const finished: RuntimeWorkerJob = {
      ...currentWorkerJob,
      ...patch,
      status,
      finishedAt: new Date().toISOString(),
    };
    currentWorkerJob = undefined;
    lastWorkerJob = finished;
  }

  const activeServer = server;
  const activePipeServer = pipeServer;
  if (!activeServer || !activePipeServer) throw new Error("OpenCanon runtime transport did not start.");

  return {
    url: formatHttpBaseUrl(host, activeServer.port),
    pipeEndpoint: activePipeServer.endpoint,
    authToken,
    async stop() {
      await stopInternal();
    },
  };

  async function stopInternal(): Promise<void> {
    if (stopped) return;
    stopped = true;
    if (startupRebuildTimer) clearTimeout(startupRebuildTimer);
    startupRebuildTimer = undefined;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (producerReadyDebounce) clearTimeout(producerReadyDebounce);
    producerReadyDebounce = undefined;
    stopStoreWatcher();
    stopCoordinationWatcher();
    projectTypesRuntime.stop();
    setLiveTypeFactsProviderFactory(undefined);
    setProjectAstFactsProviderFactory(undefined);
    fixtureAst.dispose();
    await typeProducerRuntime?.stop();
    await stateManager.waitForIdle();
    stateManager.stop();
    events.close();
    await pipeServer?.stop(true);
    await server?.stop(true);
    await tracer.shutdown().catch(() => undefined);
    await storeResource.dispose();
    workerLease.release();
  }
}

function watcherBatchSummary(batch: WatcherEventBatch): string | undefined {
  if (batch.stale) return batch.reason ?? "Engine watcher requested a full reindex.";
  if (batch.paths.length === 0) return undefined;
  return batch.paths.length === 1 ? `Indexed changed file ${batch.paths[0]}.` : `Indexed ${batch.paths.length} changed files.`;
}

async function serveRuntime(input: { host: string; port: number; routeRequest(request: Request): Promise<Response> }): Promise<{ port: number; stop(force?: boolean): Promise<void> }> {
  const sockets = new Set<Socket>();
  const nodeServer = createServer(async (nodeRequest, nodeResponse) => {
    await handleNodeRequest(input, nodeRequest, nodeResponse);
  });
  nodeServer.keepAliveTimeout = 255_000;
  nodeServer.headersTimeout = 256_000;
  nodeServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  try {
    await listenNodeServer(nodeServer, input.host, input.port);
    const address = nodeServer.address();
    const port = typeof address === "object" && address ? address.port : input.port;
    return { port, stop: (force?: boolean) => closeNodeServer(nodeServer, sockets, Boolean(force)) };
  } catch (error) {
    throw error;
  }
}

function listenNodeServer(server: NodeHttpServer, host: string, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

async function closeNodeServer(server: NodeHttpServer, sockets: Set<Socket>, force: boolean): Promise<void> {
  if (force) {
    for (const socket of sockets) socket.destroy();
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function handleNodeRequest(
  input: { host: string; routeRequest(request: Request): Promise<Response> },
  nodeRequest: IncomingMessage,
  nodeResponse: ServerResponse,
): Promise<void> {
  const abortController = new AbortController();
  let responseFinished = false;
  nodeRequest.on("aborted", () => abortController.abort());
  nodeResponse.on("finish", () => {
    responseFinished = true;
  });
  nodeResponse.on("close", () => {
    if (!responseFinished) abortController.abort();
  });

  try {
    const method = nodeRequest.method ?? "GET";
    let body: Buffer | undefined;
    if (method !== "GET" && method !== "HEAD") {
      const declared = Number(nodeRequest.headers["content-length"]);
      if (Number.isFinite(declared) && declared > MaxRequestBodyBytes) {
        respondJson(nodeResponse, 413, diagnosticsFailure(["Request body exceeds the maximum allowed size."]));
        return;
      }
      const read = await readBodyWithLimit(nodeRequest, MaxRequestBodyBytes);
      if (read === null) {
        respondJson(nodeResponse, 413, diagnosticsFailure(["Request body exceeds the maximum allowed size."]));
        return;
      }
      body = read;
    }
    const request = incomingMessageToRequest(nodeRequest, input.host, abortController.signal, body);
    const response = await input.routeRequest(request);
    await writeNodeResponse(response, nodeResponse, abortController.signal);
  } catch (error) {
    if (abortController.signal.aborted) return;
    if (!nodeResponse.headersSent) {
      // Log the detail server-side; return a generic message so internal paths/state
      // (abs paths, git stderr, engine internals) never reach the client.
      console.error("[opencanon-runtime] unhandled request error:", error instanceof Error ? error.stack ?? error.message : String(error));
      respondJson(nodeResponse, 500, diagnosticsFailure(["Internal runtime error."]));
      return;
    }
    nodeResponse.destroy(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Maximum accepted request body. Bounds memory against an authenticated client posting
 * an unbounded body to validate/settings/authoring routes. */
const MaxRequestBodyBytes = 64 * 1024 * 1024;

function respondJson(nodeResponse: ServerResponse, status: number, payload: unknown): void {
  nodeResponse.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  nodeResponse.end(JSON.stringify(payload));
}

/** Read the request stream into a Buffer, returning null if it exceeds `limit` (the
 * stream is destroyed). Guards against a missing/lying content-length header. */
function readBodyWithLimit(nodeRequest: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    nodeRequest.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > limit) {
        nodeRequest.destroy();
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    nodeRequest.on("end", () => resolve(Buffer.concat(chunks)));
    nodeRequest.on("error", reject);
  });
}

function incomingMessageToRequest(nodeRequest: IncomingMessage, fallbackHost: string, signal: AbortSignal, body?: Buffer): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRequest.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === "string") {
      headers.set(name, value);
    }
  }
  // Build the URL from the configured bind host, not the client-supplied Host header, so
  // routing/any future absolute-URL logic can't be steered by a forged Host.
  const url = new URL(nodeRequest.url ?? "/", `http://${fallbackHost}`);
  const method = nodeRequest.method ?? "GET";
  const init: RequestInit & { duplex?: "half" } = { headers, method, signal };
  if (body && method !== "GET" && method !== "HEAD") {
    init.body = new Uint8Array(body);
  }
  return new Request(url, init);
}

async function writeNodeResponse(response: Response, nodeResponse: ServerResponse, signal: AbortSignal): Promise<void> {
  nodeResponse.statusCode = response.status;
  nodeResponse.statusMessage = response.statusText;
  response.headers.forEach((value, key) => {
    nodeResponse.setHeader(key, value);
  });

  if (!response.body) {
    nodeResponse.end();
    return;
  }

  const reader = response.body.getReader();
  const cancelReader = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal.addEventListener("abort", cancelReader, { once: true });
  try {
    while (!signal.aborted) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength === 0) continue;
      if (!nodeResponse.write(chunk.value)) await waitForDrain(nodeResponse, signal);
    }
    if (!nodeResponse.destroyed) nodeResponse.end();
  } finally {
    signal.removeEventListener("abort", cancelReader);
    reader.releaseLock();
  }
}

function waitForDrain(nodeResponse: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted || nodeResponse.destroyed) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      nodeResponse.off("drain", onDrain);
      nodeResponse.off("close", onClose);
      nodeResponse.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAbort = () => {
      cleanup();
      resolve();
    };
    nodeResponse.once("drain", onDrain);
    nodeResponse.once("close", onClose);
    nodeResponse.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function refreshSnapshotRefreshStatus(snapshot: RuntimeSnapshot, store: ProjectStore, reason?: string): RuntimeSnapshot {
  const projectRefresh = store.project.status().refresh;
  const refresh = reason ? { ...projectRefresh, status: ProjectRefreshStatusValue.Stale, mode: ProjectRefreshModeValue.Manual, reason } : projectRefresh;
  const status: RuntimeSnapshot["health"]["status"] =
    snapshot.health.status === RuntimeHealthStatusValue.Failed
      ? RuntimeHealthStatusValue.Failed
      : refresh.status === ProjectRefreshStatusValue.Live
        ? RuntimeHealthStatusValue.Ready
        : RuntimeHealthStatusValue.Stale;
  const health = { ...snapshot.health, status, refresh };
  return { ...snapshot, health, state: { ...snapshot.state, health } };
}

async function canonHistoryFromRuntime(rootDir: string, url: URL): Promise<Response> {
  const kind = parseDefinitionHistoryKind(url.searchParams.get(UrlSearchParam.Kind) ?? "");
  if (!kind) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "kind must be convention, area, spec, or change."), 400);
  const id = (url.searchParams.get(UrlSearchParam.Id) ?? "").trim();
  if (!id) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "id is required."), 400);

  const targetResult = await loadDefinitionHistoryTarget(rootDir, kind, id);
  if (!targetResult.ok) return json(diagnosticsFailure(targetResult.diagnostics), 404);

  const git = runConventionGit(rootDir, buildDefinitionHistoryGitArgs(targetResult.target.files));
  return json({
    ok: true,
    data: {
      target: targetResult.target,
      gitRoot: git.gitRoot,
      args: git.args,
      diagnostics: git.diagnostics,
      commits: parseConventionGitLog(git.stdout),
    },
  });
}

function parseDefinitionHistoryKind(value: string): DefinitionHistoryKind | undefined {
  if (
    value === DefinitionHistoryKindValue.Convention ||
    value === DefinitionHistoryKindValue.Area ||
    value === DefinitionHistoryKindValue.Spec ||
    value === DefinitionHistoryKindValue.Change
  ) return value;
  return undefined;
}

async function loadDefinitionHistoryTarget(
  rootDir: string,
  kind: DefinitionHistoryKind,
  id: string,
): Promise<{ ok: true; target: DefinitionHistoryTarget } | { ok: false; diagnostics: string[] }> {
  if (kind === DefinitionHistoryKindValue.Area) return loadAreaHistoryTarget(rootDir, id);
  if (kind === DefinitionHistoryKindValue.Spec) return loadSpecHistoryTarget(rootDir, id);
  if (kind === DefinitionHistoryKindValue.Change) return loadChangeHistoryTarget(rootDir, id);
  const result = await loadConventionHistoryTarget(rootDir, id);
  if (!result.ok) return result;
  return { ok: true, target: { kind: DefinitionHistoryKindValue.Convention, ...result.target } };
}

function writeRuntimeEvent(rootDir: string, store: ProjectStore, event: CanonEvent): void {
  store.writeEvent(event);
  writeGlobalCanonEvent(rootDir, event);
}

function listRuntimeEvents(rootDir: string, store: ProjectStore, limit: number): CanonEvent[] {
  return mergeCanonEvents([...store.listEvents(limit), ...listGlobalCanonEvents(rootDir, limit)], limit);
}

function listChangeEvents(rootDir: string, store: ProjectStore, input: { changeId?: string; taskId?: string; checkId?: string; limit: number }): CanonEvent[] {
  const events = listRuntimeEvents(rootDir, store, input.limit);
  return events.filter((event) => {
    if ((event.changeIds ?? []).length === 0) return false;
    if (input.changeId && !(event.changeIds ?? []).includes(input.changeId)) return false;
    if (input.taskId && !(event.taskIds ?? []).includes(input.taskId)) return false;
    if (input.checkId && !(event.checkIds ?? []).includes(input.checkId)) return false;
    return true;
  });
}

function buildContextPacket(input: {
  rootDir: string;
  mode: string;
  snapshot: RuntimeSnapshot;
  doctorStatus: string;
  files: string[];
  changeIds: string[];
  events: CanonEvent[];
  limit: number;
}) {
  const generatedAt = new Date().toISOString();
  const semanticIndex = input.snapshot.state.semanticIndex ?? input.snapshot.semanticIndex;
  const scopedIds = scopedDefinitionIds(input.snapshot, input.files);
  const areas = sortedById(input.snapshot.areas)
    .filter((item) => scopedIds.areas.size === 0 || scopedIds.areas.has(item.id))
    .slice(0, input.limit);
  const specs = sortedById(input.snapshot.specs)
    .filter((item) => scopedIds.specs.size === 0 || scopedIds.specs.has(item.id))
    .slice(0, input.limit);
  const changes = sortedById(input.snapshot.changes)
    .filter((item) => scopedIds.changes.size === 0 || scopedIds.changes.has(item.id))
    .filter((item) => input.changeIds.length === 0 || input.changeIds.includes(item.id))
    .slice(0, input.limit);
  const conventions = sortedById(input.snapshot.conventions)
    .filter((item) => scopedIds.conventions.size === 0 || scopedIds.conventions.has(item.id))
    .slice(0, input.limit);
  const findings = [...input.snapshot.findings]
    .filter((finding) => input.files.length === 0 || (finding.file ? input.files.includes(finding.file) : false))
    .sort((left, right) => (left.file ?? "").localeCompare(right.file ?? "") || (left.line ?? 0) - (right.line ?? 0) || left.id.localeCompare(right.id))
    .slice(0, input.limit);
  const events = input.events
    .filter((event) => input.changeIds.length === 0 || event.changeIds.some((id) => input.changeIds.includes(id)))
    .slice(0, input.limit);
  const checkCount = changes.reduce((total, change) => total + change.checks.length, 0);
  const readyTasks = changes.flatMap((change) => change.tasks.filter((task) => task.ready).map((task) => ({ change, task })));
  const xml = [
    `<opencanon-context schema="opencanon.context-packet.v1" mode="${xmlAttr(input.mode)}" generated-at="${xmlAttr(generatedAt)}">`,
    `  <project root="${xmlAttr(input.rootDir)}" health="${xmlAttr(input.snapshot.health.status)}" doctor="${xmlAttr(input.doctorStatus)}" />`,
    `  <filters limit="${input.limit}">`,
    ...input.files.map((file) => `    <file path="${xmlAttr(file)}" />`),
    ...input.changeIds.map((id) => `    <change id="${xmlAttr(id)}" />`),
    `  </filters>`,
    `  <search-index status="${xmlAttr(semanticIndex?.status ?? "unknown")}" chunks="${semanticIndex?.chunkCount ?? 0}" stale="${semanticIndex?.staleChunkCount ?? 0}" embedded="${semanticIndex?.embeddingStats?.embeddedChunks ?? 0}" reused="${semanticIndex?.embeddingStats?.reusedChunks ?? 0}" model="${xmlAttr(semanticIndex?.provider.modelId ?? "unknown")}" />`,
    `  <definitions areas="${areas.length}" specs="${specs.length}" changes="${changes.length}" conventions="${conventions.length}" />`,
    `  <areas>`,
    ...areas.map((item) => `    <area id="${xmlAttr(item.id)}" title="${xmlAttr(item.title)}" checks="${item.checks.length}">${xmlText(item.summary)}</area>`),
    `  </areas>`,
    `  <specs>`,
    ...specs.map((item) => `    <spec id="${xmlAttr(item.id)}" title="${xmlAttr(item.title)}" rules="${item.ruleCount}" scenarios="${item.scenarioCount}">${xmlText(item.summary)}</spec>`),
    `  </specs>`,
  `  <changes>`,
    ...changes.map((item) => [
      `    <item id="${xmlAttr(item.id)}" title="${xmlAttr(item.title)}" column="${xmlAttr(item.boardColumn)}" checks="${item.checks.length}">`,
      `      <intent problem="${xmlAttr(item.intent.problem)}" outcome="${xmlAttr(item.intent.outcome)}" />`,
      item.tasks.length > 0 ? `      <tasks ready="${item.readyTaskCount}" blocked="${item.blockedTaskCount}">` : undefined,
      ...item.tasks.map((task) => [
        `        <task id="${xmlAttr(task.id)}" title="${xmlAttr(task.title)}" status="${xmlAttr(task.status)}" ready="${task.ready ? "true" : "false"}" checks="${task.checks.length}">`,
        ...task.files.map((file) => `          <file path="${xmlAttr(file)}" />`),
        ...task.surfaces.map((surfaceId) => `          <surface id="${xmlAttr(surfaceId)}" />`),
        ...task.updates.areas.map((id) => `          <updates kind="area" id="${xmlAttr(id)}" />`),
        ...task.updates.specs.map((id) => `          <updates kind="spec" id="${xmlAttr(id)}" />`),
        ...task.updates.conventions.map((id) => `          <updates kind="convention" id="${xmlAttr(id)}" />`),
        ...task.updates.surfaces.map((id) => `          <updates kind="surface" id="${xmlAttr(id)}" />`),
        ...task.dependsOn.map((id) => `          <depends-on task="${xmlAttr(id)}" />`),
        ...task.blockedReasons.map((reason) => `          <blocked-reason>${xmlText(reason)}</blocked-reason>`),
        `        </task>`,
      ].join("\n")),
      item.tasks.length > 0 ? `      </tasks>` : undefined,
      item.lastEvent ? `      <latest-event type="${xmlAttr(item.lastEvent.type)}" at="${xmlAttr(item.lastEvent.timestamp)}">${xmlText(item.lastEvent.summary)}</latest-event>` : undefined,
      `    </item>`,
    ].filter(Boolean).join("\n")),
    `  </changes>`,
    `  <ready-work>`,
    ...readyTasks.map(({ change, task }) => [
      `    <task change="${xmlAttr(change.id)}" id="${xmlAttr(task.id)}" title="${xmlAttr(task.title)}" checks="${task.checks.length}">`,
      ...task.files.map((file) => `      <file path="${xmlAttr(file)}" />`),
      ...task.surfaces.map((surfaceId) => `      <surface id="${xmlAttr(surfaceId)}" />`),
      ...task.checks.map((checkId) => `      <check id="${xmlAttr(checkId)}" />`),
      `      <summary>${xmlText(task.detail ?? task.title)}</summary>`,
      `    </task>`,
    ].join("\n")),
    `  </ready-work>`,
    `  <conventions>`,
    ...conventions.map((item) => `    <convention id="${xmlAttr(item.id)}" title="${xmlAttr(item.title)}" runtime="${xmlAttr(item.runtime)}" render="${xmlAttr(item.render)}">${xmlText(item.rule)}</convention>`),
    `  </conventions>`,
    `  <findings>`,
    ...findings.map((item) => `    <finding id="${xmlAttr(item.id)}" severity="${xmlAttr(item.severity)}" file="${xmlAttr(item.file ?? "project")}" line="${item.line ?? 0}">${xmlText(item.message)}</finding>`),
    `  </findings>`,
    `  <events>`,
    ...events.map((item) => `    <event id="${xmlAttr(item.id)}" type="${xmlAttr(item.type)}" at="${xmlAttr(item.timestamp)}">${xmlText(item.summary)}</event>`),
    `  </events>`,
    `</opencanon-context>`,
  ].join("\n");
  return {
    schema: "opencanon.context-packet.v1" as const,
    mode: input.mode,
    generatedAt,
    rootDir: input.rootDir,
    filters: {
      files: input.files,
      changeIds: input.changeIds,
      limit: input.limit,
    },
    xml,
    facts: {
      files: input.files.length || input.snapshot.files.length,
      conventions: conventions.length,
      areas: areas.length,
      specs: specs.length,
      changes: changes.length,
      checks: checkCount,
      readyTasks: readyTasks.length,
      findings: findings.length,
      doctorStatus: input.doctorStatus,
      semanticIndexStatus: semanticIndex?.status ?? "unknown",
      semanticIndexEmbeddedChunks: semanticIndex?.embeddingStats?.embeddedChunks ?? 0,
      semanticIndexReusedChunks: semanticIndex?.embeddingStats?.reusedChunks ?? 0,
    },
  };
}

function scopedDefinitionIds(snapshot: RuntimeSnapshot, files: string[]) {
  const areas = new Set<string>();
  const specs = new Set<string>();
  const changes = new Set<string>();
  const conventions = new Set<string>();
  for (const file of files) {
    const coverage = snapshot.definitionGraph.fileCoverage[file];
    if (!coverage) continue;
    coverage.areas.forEach((id) => areas.add(id));
    coverage.specs.forEach((id) => specs.add(id));
    coverage.changes.forEach((id) => changes.add(id));
    coverage.conventions.forEach((id) => conventions.add(id));
  }
  return { areas, specs, changes, conventions };
}

function sortedById<T extends { id: string }>(items: readonly T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}

function xmlAttr(value: string): string {
  return xmlText(value).replace(/"/g, "&quot;");
}

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

type RunChangeCheckResult = {
  changeId: string;
  taskId?: string;
  checkId: string;
  kind: ChangeCheck["kind"];
  status: "passed" | "failed";
  summary: string;
  output: string;
  exitCode?: number | string;
};

function parseRunChangeCheckRequest(
  body: Record<string, unknown>,
  changes: Change[],
): { ok: true; change: Change; task?: NonNullable<Change["tasks"]>[number]; checks: ChangeCheck[]; actor?: string } | { ok: false; diagnostics: unknown[] } {
  const diagnostics: unknown[] = [];
  const changeId = stringBodyValue(body.changeId)?.trim();
  const checkId = stringBodyValue(body.checkId)?.trim();
  const taskId = stringBodyValue(body.taskId)?.trim();
  const runAll = booleanBodyValue(body.all);
  const actor = stringBodyValue(body.actor)?.trim();
  const change = changeId ? changes.find((item) => item.id === changeId) : undefined;
  const task = taskId ? change?.tasks?.find((item) => item.id === taskId) : undefined;
  const allowedCheckIds = task ? new Set(task.checks ?? []) : undefined;
  const checks = change
    ? runAll
      ? (change.checks ?? []).filter((item) => !allowedCheckIds || allowedCheckIds.has(item.id))
      : (checkId ? (change.checks ?? []).filter((item) => item.id === checkId && (!allowedCheckIds || allowedCheckIds.has(item.id))) : [])
    : [];

  if (!changeId) diagnostics.push(runtimeInputDiagnostic("changeId is required."));
  else if (!change) diagnostics.push(runtimeInputDiagnostic(`Unknown change id: ${changeId}.`));
  if (taskId && !task) diagnostics.push(runtimeInputDiagnostic(`Unknown task id for ${changeId ?? "change"}: ${taskId}.`));
  if (!runAll && !checkId) diagnostics.push(runtimeInputDiagnostic("checkId is required unless all is true."));
  if (runAll && checkId) diagnostics.push(runtimeInputDiagnostic("Use either checkId or all, not both."));
  if (change && task && (task.checks ?? []).length === 0) diagnostics.push(runtimeInputDiagnostic(`Task ${task.id} has no checks.`));
  if (change && checks.length === 0 && diagnostics.length === 0) {
    diagnostics.push(runtimeInputDiagnostic(task ? `No matching checks for task ${task.id}.` : `No matching checks for change ${change.id}.`));
  }
  if (diagnostics.length > 0 || !change || checks.length === 0) return { ok: false, diagnostics };
  return { ok: true, change, ...(task ? { task } : {}), checks, actor: actor || undefined };
}

function createChangeCheckEvent(input: {
  changeId: string;
  taskId?: string;
  checkId: string;
  type: ChangeEventType;
  actor?: string;
  summary: string;
}): CanonEvent {
  const timestamp = new Date().toISOString();
  return CanonEventSchema.parse({
    id: `change:${input.changeId}:${input.checkId}:${input.type}:${timestamp}:${randomUUID().slice(0, 8)}`,
    type: input.type,
    timestamp,
    actor: input.actor,
    files: [],
    changeIds: [input.changeId],
    taskIds: input.taskId ? [input.taskId] : [],
    checkIds: [input.checkId],
    conventionIds: [],
    validatorIds: [],
    findingIds: [],
    summary: input.summary,
  });
}

async function runChangeCheck(
  rootDir: string,
  project: Awaited<ReturnType<typeof loadProjectContext>>,
  change: Change,
  check: ChangeCheck,
  store: ProjectStore,
  task?: NonNullable<Change["tasks"]>[number],
): Promise<RunChangeCheckResult> {
  if (check.kind === ChangeCheckKind.Doctor) {
    const report = buildDoctorReport({
      paths: project.paths,
      areas: project.areas,
      specs: project.specs,
      changes: project.changes,
      conventions: project.conventions,
      validators: project.validators,
      producerStatuses: resolveProducerStatuses(rootDir),
      semanticIndex: store.readSemanticIndexStatus({ indexId: "project" }).index,
    });
    return {
      changeId: change.id,
      ...(task ? { taskId: task.id } : {}),
      checkId: check.id,
      kind: check.kind,
      status: report.status === "fail" ? "failed" : "passed",
      summary: report.status === "fail" ? `Check ${check.id} failed: doctor status fail.` : `Check ${check.id} passed: doctor status ${report.status}.`,
      output: trimCheckOutput(report.checks.map((item) => `${item.id}: ${item.status} - ${item.message}`).join("\n")),
    };
  }

  if (check.kind === ChangeCheckKind.Validator) {
    const validator = project.validators.find((item) => item.id === check.validatorId);
    if (!validator) {
      return {
        changeId: change.id,
        ...(task ? { taskId: task.id } : {}),
        checkId: check.id,
        kind: check.kind,
        status: "failed",
        summary: `Check ${check.id} failed: unknown validator ${check.validatorId}.`,
        output: "",
      };
    }
    const scopedFiles = task?.files && task.files.length > 0 ? task.files : definitionTargetFiles(change.scope);
    const validation = await runValidation({
      rootDir,
      paths: project.paths,
      conventions: project.conventions,
      validators: [validator],
      files: scopedFiles,
      project: scopedFiles.length === 0,
      producerPolicy: InteractiveProducerPolicy,
    });
    const failed = validation.diagnostics.length > 0 || validation.findings.some((finding) => finding.severity === FindingSeverityValue.Error);
    return {
      changeId: change.id,
      ...(task ? { taskId: task.id } : {}),
      checkId: check.id,
      kind: check.kind,
      status: failed ? "failed" : "passed",
      summary: failed ? `Check ${check.id} failed: validator ${check.validatorId} reported issues.` : `Check ${check.id} passed: validator ${check.validatorId}.`,
      output: trimCheckOutput([
        ...validation.diagnostics,
        ...validation.findings.map((finding) => `${finding.file}:${finding.line} ${finding.severity} ${finding.message}`),
      ].join("\n")),
    };
  }

  if (check.kind === ChangeCheckKind.Command) {
    return runShellCheck(rootDir, change.id, task?.id, check.id, check.kind, check.command);
  }

  return runShellCheck(rootDir, change.id, task?.id, check.id, check.kind, testCommandForTarget(check.target));
}

function testCommandForTarget(target: string): string {
  const normalized = target.replace(/\\/g, "/");
  const crateMatch = /^crates\/([^/]+)\//.exec(normalized);
  if (crateMatch) return `cargo test --manifest-path ${quoteShellArg(`crates/${crateMatch[1]}/Cargo.toml`)}`;
  return `npx vitest run ${quoteShellArg(target)}`;
}

async function runShellCheck(
  rootDir: string,
  changeId: string,
  taskId: string | undefined,
  checkId: string,
  kind: ChangeCheck["kind"],
  command: string,
): Promise<RunChangeCheckResult> {
  const checkRuntime = createIsolatedShellCheckRuntime(rootDir);
  try {
    const { stdout, stderr } = await execCommand(command, {
      cwd: rootDir,
      timeout: CheckCommandTimeoutMs,
      maxBuffer: CheckCommandMaxBuffer,
      env: checkRuntime.env,
    });
    const output = trimCheckOutput([stdout, stderr].filter(Boolean).join("\n"));
    return {
      changeId,
      ...(taskId ? { taskId } : {}),
      checkId,
      kind,
      status: "passed",
      summary: `Check ${checkId} passed.`,
      output,
    };
  } catch (error) {
    const failure = error as Error & { stdout?: string; stderr?: string; code?: number | string; signal?: string };
    const output = trimCheckOutput([failure.stdout, failure.stderr, failure.message].filter(Boolean).join("\n"));
    return {
      changeId,
      ...(taskId ? { taskId } : {}),
      checkId,
      kind,
      status: "failed",
      summary: `Check ${checkId} failed${failure.signal ? ` (${failure.signal})` : ""}.`,
      output,
      exitCode: failure.code,
    };
  } finally {
    await cleanupIsolatedShellCheckRuntime(checkRuntime);
  }
}

type IsolatedShellCheckRuntime = {
  dir: string;
  registryPath: string;
  env: NodeJS.ProcessEnv;
};

const ShellCheckRuntimeEnvKeys = [
  "OPENCANON_SERVICE_TOKEN",
  "OPENCANON_SERVICE_LEASE_ID",
  "OPENCANON_SERVICE_OWNER_PID",
  "OPENCANON_SERVICE_PIPE_ENDPOINT",
  "OPENCANON_RUNTIME_TOKEN",
  "OPENCANON_RUNTIME_LEASE_ID",
  "OPENCANON_RUNTIME_PIPE_ENDPOINT",
] as const;

function createIsolatedShellCheckRuntime(rootDir: string): IsolatedShellCheckRuntime {
  const parentDir = path.join(rootDir, ".opencanon");
  mkdirSync(parentDir, { recursive: true });
  const dir = mkdtempSync(path.join(parentDir, "check-"));
  const registryPath = path.join(dir, "service.json");
  const env: NodeJS.ProcessEnv = { ...process.env, OPENCANON_SERVICE_REGISTRY_PATH: registryPath };
  for (const key of ShellCheckRuntimeEnvKeys) delete env[key];
  return { dir, registryPath, env };
}

async function cleanupIsolatedShellCheckRuntime(runtime: IsolatedShellCheckRuntime): Promise<void> {
  await stopService(runtime.registryPath).catch(() => undefined);
  rmSync(runtime.dir, { recursive: true, force: true });
}

function trimCheckOutput(output: string, maxChars = 6000): string {
  const text = output.trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n\nOutput truncated.`;
}

function quoteShellArg(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function parseChangeEventRequest(
  body: Record<string, unknown>,
  changes: Change[],
): { ok: true; event: CanonEvent } | { ok: false; diagnostics: unknown[] } {
  const diagnostics: unknown[] = [];
  const changeId = stringBodyValue(body.changeId)?.trim();
  const taskId = stringBodyValue(body.taskId)?.trim();
  const checkId = stringBodyValue(body.checkId)?.trim();
  const type = stringBodyValue(body.type)?.trim();
  const summary = stringBodyValue(body.summary)?.trim();
  const actor = stringBodyValue(body.actor)?.trim();
  const id = stringBodyValue(body.id)?.trim();
  const files = stringArrayBodyValue(body.files);

  if (!changeId) diagnostics.push(runtimeInputDiagnostic("changeId is required."));
  else if (!changes.some((change) => change.id === changeId)) diagnostics.push(runtimeInputDiagnostic(`Unknown change id: ${changeId}.`));
  const change = changeId ? changes.find((item) => item.id === changeId) : undefined;
  const task = taskId ? change?.tasks?.find((item) => item.id === taskId) : undefined;
  const check = checkId ? change?.checks?.find((item) => item.id === checkId) : undefined;
  if (taskId && !task) diagnostics.push(runtimeInputDiagnostic(`Unknown task id for ${changeId ?? "change"}: ${taskId}.`));
  if (checkId && !check) diagnostics.push(runtimeInputDiagnostic(`Unknown check id for ${changeId ?? "change"}: ${checkId}.`));
  if (!type) diagnostics.push(runtimeInputDiagnostic("type is required."));
  else if (!changeEventTypes.has(type)) diagnostics.push(runtimeInputDiagnostic(`Unsupported change event type: ${type}.`));
  if (type && String(type).startsWith("task-") && !taskId) diagnostics.push(runtimeInputDiagnostic(`${type} requires taskId.`));
  if (type && String(type).includes("check") && !checkId) diagnostics.push(runtimeInputDiagnostic(`${type} requires checkId.`));
  if (!summary) diagnostics.push(runtimeInputDiagnostic("summary is required."));
  if (files.length > 0) {
    const safeFiles = validateRelativePaths(files);
    if (!safeFiles.ok) diagnostics.push(...getOpenCanonErrorDiagnostics(safeFiles.error.error));
  }
  if (diagnostics.length > 0) return { ok: false, diagnostics };

  const timestamp = new Date().toISOString();
  const event = CanonEventSchema.parse({
    id: id ?? `change:${changeId}:${type}:${timestamp}:${randomUUID().slice(0, 8)}`,
    type,
    timestamp,
    actor: actor || undefined,
    files,
    changeIds: [changeId],
    taskIds: taskId ? [taskId] : [],
    checkIds: checkId ? [checkId] : [],
    conventionIds: [],
    validatorIds: [],
    findingIds: [],
    summary,
  });
  return { ok: true, event };
}

function applyTaskOwnershipEvent(rootDir: string, event: CanonEvent): { ok: true; event: CanonEvent } | { ok: false; status: number; diagnostics: unknown[] } {
  const changeId = event.changeIds[0];
  const taskId = event.taskIds[0];
  if (!changeId || !taskId) return { ok: true, event };

  if (event.type === ChangeTaskEventType.Claimed) {
    const claim = claimTaskLease({
      rootDir,
      changeId,
      taskId,
      agentId: event.actor,
      summary: event.summary,
    });
    if (!claim.ok) return { ok: false, status: claim.status, diagnostics: claim.diagnostics };
    return { ok: true, event: eventWithLeaseActor(event, claim.result.lease.agentId) };
  }

  if (event.type === ChangeTaskEventType.Closed || event.type === ChangeTaskEventType.Blocked) {
    const release = releaseTaskLease({
      rootDir,
      changeId,
      taskId,
      agentId: event.actor,
      status: event.type === ChangeTaskEventType.Blocked ? TaskLeaseStatus.Stale : TaskLeaseStatus.Released,
      summary: event.summary,
    });
    if (!release.ok) return { ok: false, status: release.status, diagnostics: release.diagnostics };
    return { ok: true, event: release.lease ? eventWithLeaseActor(event, release.lease.agentId) : event };
  }

  if (event.type === ChangeTaskEventType.Started || event.type === ChangeTaskEventType.Review || event.type === ChangeTaskEventType.Ready) {
    const owner = requireTaskLeaseOwner({
      rootDir,
      changeId,
      taskId,
      agentId: event.actor,
      summary: event.summary,
    });
    if (!owner.ok) return { ok: false, status: owner.status, diagnostics: owner.diagnostics };
    return { ok: true, event: eventWithLeaseActor(event, owner.lease.agentId) };
  }

  return { ok: true, event };
}

function eventWithLeaseActor(event: CanonEvent, agentId: string): CanonEvent {
  if (event.actor) return event;
  return CanonEventSchema.parse({ ...event, actor: agentId });
}

function runtimeInputDiagnostic(message: string) {
  return createOpenCanonDiagnostic({ code: diagnosticCodes.invalidRuntimeResponse, message });
}

async function approveCommitGateFromRuntime(rootDir: string, request: Request): Promise<Response> {
  const parsed = await readJsonObjectBody(request);
  if (!parsed.ok) return malformedBodyResponse();
  const body = parsed.body;
  const gateId = stringBodyValue(body.gateId)?.trim();
  const summary = stringBodyValue(body.summary)?.trim();
  if (!gateId) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "gateId is required."), 400);
  if (!summary) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "summary is required."), 400);

  const paths = createPaths(rootDir);
  const pending = loadPendingCommitGates(paths);
  const matchingGates = pending.pending.filter((gate) => gate.id === gateId);
  if (matchingGates.length > 1) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `Commit gate id is ambiguous: ${gateId}.`), 400);
  const gate = matchingGates[0];
  if (!gate) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, `No pending commit gate found with id: ${gateId}.`), 404);
  if (pending.context.rootDir && pending.context.rootDir !== rootDir) {
    return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "Pending gate cache belongs to a different project root."), 409);
  }

  const loadedApprovals = loadCommitApprovalsWithDiagnostics(paths);
  if (loadedApprovals.diagnostics.length > 0) return json(diagnosticsFailure(loadedApprovals.diagnostics), 400);
  const record = createCommitApprovalRecord({
    gate,
    summary,
    approvedBy: stringBodyValue(body.approvedBy),
    approvedVia: "manual",
    context: pending.context,
  });
  const approvals = upsertCommitApproval(loadedApprovals.approvals, record);
  saveCommitApprovals(paths, approvals);
  const resolved = resolveCommitGates([...pending.pending, ...pending.approved], approvals, pending.context);
  const gates = savePendingCommitGates(paths, {
    context: pending.context,
    gates: resolved,
    diagnostics: pending.diagnostics,
    governingConventions: pending.governingConventions,
  });
  return json({ ok: true, data: { approval: record, gates } });
}

async function validateFromRuntime(rootDir: string, request: Request): Promise<Response> {
  const parsed = await readJsonObjectBody(request);
  if (!parsed.ok) return malformedBodyResponse();
  const body = parsed.body;
  // H2: the same containment guard every GET FS route uses. `files` may be empty
  // (whole-project run); only when paths are supplied must each be a contained,
  // non-escaping relative path — an absolute or `..` path is rejected with a 400
  // BEFORE any file read, so an authenticated client cannot read outside rootDir.
  const requestedFiles = stringArrayBodyValue(body.files);
  if (requestedFiles.length > 0) {
    const safeFiles = validateRelativePaths(requestedFiles);
    if (!safeFiles.ok) return json(safeFiles.error, 400);
  }
  const project = await loadProjectContext(rootDir);
  const profiler = createProfiler(booleanBodyValue(body.profile));
  const producerPolicy = producerPolicyBodyValue(body.producerPolicy);
  if (!producerPolicy.ok) return json(diagnosticsFailure(producerPolicy.diagnostics), 400);
  const data = await runValidation({
    rootDir: project.rootDir,
    paths: project.paths,
    conventions: project.conventions,
    validators: project.validators,
    files: requestedFiles,
    topics: stringArrayBodyValue(body.topics),
    validatorIds: stringArrayBodyValue(body.validatorIds),
    project: booleanBodyValue(body.project),
    fixMode: fixModeBodyValue(body.fixMode),
    dryRun: booleanBodyValue(body.dryRun),
    strictProducers: booleanBodyValue(body.strictProducers),
    producerPolicy: producerPolicy.policy,
    profiler,
  });
  return json({ ok: true, data });
}

async function feedbackFromRuntime(rootDir: string, request: Request): Promise<Response> {
  const parsed = await readJsonObjectBody(request);
  if (!parsed.ok) return malformedBodyResponse();
  const body = parsed.body;
  // H2: reject absolute/escaping paths before runFeedback reads any file.
  const requestedFiles = stringArrayBodyValue(body.files);
  if (requestedFiles.length > 0) {
    const safeFiles = validateRelativePaths(requestedFiles);
    if (!safeFiles.ok) return json(safeFiles.error, 400);
  }
  const data = await runFeedback({
    cwd: rootDir,
    files: requestedFiles,
    host: feedbackHostBodyValue(body.host),
    sessionId: stringBodyValue(body.sessionId),
    turnId: stringBodyValue(body.turnId),
    dedupeScope: feedbackDedupeScopeBodyValue(body.dedupeScope),
  });
  return json({ ok: true, data });
}

async function hookFeedbackFromRuntime(rootDir: string, request: Request) {
  const body = await readJsonBody(request);
  const feedback = await createHookFeedback(feedbackHostBodyValue(body.host), body.payload, rootDir);
  return {
    feedback,
    response: renderHookResponse(feedback),
  };
}

async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Strict body parse for routes that DO real change (validate/feedback): an empty
 * body is valid (use defaults), but a non-empty body that is not a JSON object
 * is a client error and must 400 — never silently fall back to `{}` and run a
 * default (potentially expensive) validation, masking a malformed request.
 */
async function readJsonObjectBody(request: Request): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  const text = await request.text();
  if (text.trim().length === 0) return { ok: true, body: {} };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return { ok: true, body: parsed as Record<string, unknown> };
    return { ok: false };
  } catch {
    return { ok: false };
  }
}

function malformedBodyResponse(): Response {
  return json(diagnosticsFailure(["Request body is not valid JSON."]), 400);
}

function stringArrayBodyValue(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.length > 0) : [];
}

function stringBodyValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanBodyValue(value: unknown): boolean {
  return value === true;
}

function fixModeBodyValue(value: unknown): FixMode | undefined {
  if (value === FixModeInput.Safe || value === FixModeInput.Suggested || value === FixModeInput.All) return value;
  return undefined;
}

function producerPolicyBodyValue(value: unknown): { ok: true; policy: ProducerPolicy } | { ok: false; diagnostics: string[] } {
  if (value === undefined) return { ok: true, policy: InteractiveProducerPolicy };
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, diagnostics: ["producerPolicy must be an object with profile 'batch' or 'interactive'."] };
  }
  const profile = (value as { profile?: unknown }).profile;
  if (profile === ProducerRunProfile.Batch) return { ok: true, policy: BatchProducerPolicy };
  if (profile === ProducerRunProfile.Interactive) return { ok: true, policy: InteractiveProducerPolicy };
  return { ok: false, diagnostics: ["producerPolicy.profile must be 'batch' or 'interactive'."] };
}

function feedbackHostBodyValue(value: unknown): FeedbackHost {
  if (value === FeedbackHostValue.Codex || value === FeedbackHostValue.Claude || value === FeedbackHostValue.OpenCode || value === FeedbackHostValue.Manual) return value;
  return FeedbackHostValue.Manual;
}

function feedbackDedupeScopeBodyValue(value: unknown): "off" | "turn" | "session" | undefined {
  if (value === "off" || value === "turn" || value === "session") return value;
  return undefined;
}

export async function checkRuntimePrerequisites(): Promise<string> {
  try {
    const prerequisites = assertRuntimePrerequisites();
    const engine = prerequisites.engine.version();
    return [
      "# OpenCanon Runtime Check",
      "",
      `Node: ${prerequisites.nodeVersion} (required ${requiredNodeRequirement})`,
      `Engine: ${engine.engineVersion} (package ${engine.packageVersion}, NAPI ${engine.napiVersion})`,
      "State: SQLite engine",
      "Watcher: engine notify",
    ].join("\n");
  } catch (error) {
    return renderPrerequisiteFailure(error);
  }
}

function numberParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function nonNegativeNumberParam(url: URL, key: string, fallback: number): number {
  const raw = url.searchParams.get(key);
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

function validateRelatedSelectors(
  snapshot: RuntimeSnapshot,
  query: { conventionIds: string[]; validatorIds: string[]; findingIds: string[] },
): { status: number; error: RuntimeError } | undefined {
  const missingConvention = query.conventionIds.find((id) => !snapshot.conventions.some((convention) => convention.id === id));
  if (missingConvention) return { status: 404, error: diagnostic(diagnosticCodes.invalidRuntimeResponse, `Unknown convention id: ${missingConvention}.`) };
  const missingValidator = query.validatorIds.find((id) => !snapshot.validators.some((validator) => validator.id === id));
  if (missingValidator) return { status: 404, error: diagnostic(diagnosticCodes.invalidRuntimeResponse, `Unknown validator id: ${missingValidator}.`) };
  const missingFinding = query.findingIds.find((id) => !snapshot.findings.some((finding) => finding.id === id));
  if (missingFinding) return { status: 404, error: diagnostic(diagnosticCodes.invalidRuntimeResponse, `Unknown finding id: ${missingFinding}.`) };
  return undefined;
}
