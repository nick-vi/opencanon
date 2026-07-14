import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, watch, type FSWatcher } from "node:fs";
import path from "node:path";
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
  createValidationResultCache,
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
  isCodeGraphIndexableFile,
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
  ProjectRefreshModeValue,
  ProjectRefreshStatusValue,
  RuntimeWorkerJobKindValue,
  RuntimeWorkerJobStatusValue,
  TaskLeaseStatus,
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
  type ValidationResultCache,
  type WatcherEventBatch,
} from "@opencanon/core";
import { buildRuntimeSnapshot, buildStartupRuntimeSnapshot, buildProjectSummary, buildRelatedCanon, runtimeSnapshotFailure, gitDiffSnapshot, gitHistorySnapshot, type RuntimeSnapshot } from "./snapshot.ts";
import { TreeScope, buildTreeResponse, listProjectInventory, readFileResponse, treeScopeParam, validateCommitHash, validateOptionalRelativePaths, validateRelativePath, validateRelativePaths } from "./server-fs.ts";
import { createEventBroadcaster, indexedEvent, indexingEvent, snapshotEvent, streamErrorEvent, type RuntimeStreamProgress } from "./server-events.ts";
import { MaxRequestBodyBytes, serveRuntime } from "./server-http.ts";
import { createRuntimeRouteHandler } from "./server-routes.ts";
import { assertRuntimePrerequisites, formatHttpBaseUrl, renderPrerequisiteFailure, requiredNodeRequirement, type RuntimePrerequisites } from "./runtime.ts";
import { createProjectStore, type ProjectStore } from "./state.ts";
import { readProjectSettings, writeProjectSettings } from "./settings.ts";
import { applyAuthoringValidator, listAuthoringFactories, listAuthoringValidators, previewAuthoringValidator, runAuthoringValidatorFixtures } from "./authoring.ts";
import { assertSafeRuntimeHost, createRuntimeAuthToken, isAuthorizedRuntimeRequest, usableRuntimeAuthToken } from "./auth.ts";
import { listProjects } from "./project-summary.ts";
import { ApiPathPrefix, ApiRoute, ProjectIndexResponseMode, UrlSearchParam, diagnostic, diagnosticCodes, diagnosticsFailure, json, validateRuntimeAuth, validateMethod, type RuntimeError } from "./routes.ts";
import { localPipeEndpoint, serveLocalProtocolPipe, type LocalProtocolPipeServer } from "./local-protocol.ts";
import { acquireProjectWorkerLease, stopService } from "./service.ts";
import { createLifecycle } from "./service-lifecycle.ts";
import { readProjectRuntimeEntry, readRuntimeRegistry, setRuntimeLifecycleForLease } from "./service-storage.ts";
import { ProcessLifecycleStatus, type RuntimeRegistryEntry } from "./service-types.ts";
import { createValidatorGraphRuntime } from "./validator-graph-runtime.ts";
import { createProjectTypesRuntime } from "./project-types-runtime.ts";
import { createTypeProducerRuntime, defaultTsconfigPath } from "./type-producer/runtime.ts";
import { LiveTypeProducerProvider } from "./type-producer/live-provider.ts";
import { createRuntimeStateManager, type RuntimeRebuildOptions } from "./state-manager.ts";
import { createChangeCheckRunner } from "./change-check-runner.ts";
import { createKnowledgeIndexManager, type KnowledgeIndexProgress } from "./knowledge-index-manager.ts";
import { createRuntimeActivityTracker } from "./activity-tracker.ts";
import { ProjectFileLanguage, setLiveTypeFactsProviderFactory, setProjectAstFactsProviderFactory, resolveProducerStatuses, normalizeProducerStatusesForProject } from "@opencanon/core";
import { createCliAstFactsProvider, engineProjectAstFactsProvider } from "./ast-facts-provider.ts";
import { createProjectObservabilityExporter } from "./observability.ts";
import { readRuntimeProcessEnvironment } from "./runtime-process-environment.ts";
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

const RuntimeHealthStatusValue = {
  Failed: "failed",
  Indexing: "indexing",
  Ready: "ready",
  Stale: "stale",
} as const;

const CoordinationRefreshDebounceMs = 150;
const KnowledgeWatchDebounceMs = 1_000;
const KnowledgeIndexStatus = {
  Failed: "failed",
  Missing: "missing",
} as const;

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
  onStopped?: () => void | Promise<void>;
  runtime?: RuntimePrerequisites;
};

export type RuntimeServer = {
  url: string;
  pipeEndpoint: string;
  authToken: string;
  stop(): Promise<void>;
};

export async function startOpenCanonRuntime(options: RuntimeServerOptions = {}): Promise<RuntimeServer> {
  const cwd = options.cwd ?? process.cwd();
  const rootDir = resolveRootDir(cwd);
  const host = options.host ?? "127.0.0.1";
  assertSafeRuntimeHost(host, options.allowRemote);
  const authToken = usableRuntimeAuthToken(options.authToken) ?? usableRuntimeAuthToken(process.env.OPENCANON_RUNTIME_TOKEN) ?? createRuntimeAuthToken();
  const port = options.port ?? 4767;
  const runtimeEnvironment = readRuntimeProcessEnvironment();
  const runtimeRegistryPath = runtimeEnvironment.registryPath;
  const configuredPipeEndpoint = runtimeEnvironment.pipeEndpoint;
  const processIdentity = {
    kind: "runtime" as const,
    pid: process.pid,
    leaseId: runtimeEnvironment.leaseId,
  };
  let paths = createPaths(rootDir);
  const configDiagnostics = validateConfig(paths);
  if (configDiagnostics.length > 0) {
    throw new Error(`Invalid OpenCanon config:\n${configDiagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`);
  }
  const prerequisites = options.runtime ?? assertRuntimePrerequisites();
  const workerLease = acquireProjectWorkerLease({
    rootDir,
    leaseId: processIdentity.leaseId,
    registryPath: runtimeRegistryPath,
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
  const validationResultCache = createValidationResultCache(paths);
  let snapshot: RuntimeSnapshot;
  try {
    snapshot = await tracer.span("runtime.snapshot.boot", { kind: SpanKind.TASK, attributes: { phase: "boot" } }, async (span) => {
      const next = await buildStartupRuntimeSnapshot({
        cwd: rootDir,
        engine: prerequisites.engine,
        store,
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
  const runtimeBusyActivities = new Map<symbol, string>();
  const changeCheckBusyActivity = Symbol("change-checks");
  let validatorGraphRuntime: ReturnType<typeof createValidatorGraphRuntime> | undefined;
  const stateManager = createRuntimeStateManager({
    initialSnapshot: snapshot,
    initialProjectInventory: listProjectInventory(rootDir),
    initialValidationResultCache: validationResultCache,
    isStopped: () => stopped,
    rebuildNow: rebuildAndPublishNow,
    readProjectInventory: () => listProjectInventory(rootDir),
    onRebuildError(error) {
      events.broadcast(streamErrorEvent(formatOpenCanonDiagnostics(getOpenCanonErrorDiagnostics(runtimeSnapshotFailure(error).error))));
    },
  });
  const changeCheckRunner = await createChangeCheckRunner({
    rootDir,
    executor: { runtimeNamespace: runtimeEnvironment.runtimeNamespace, leaseId: processIdentity.leaseId },
    tracer,
    events,
    stateManager,
    store: () => store,
    validationResultCache: () => stateManager.validationResultCache(),
    onActivity: resetIdleTimer,
    onActiveWorkChanged(active) {
      setRuntimeBusyActivity(changeCheckBusyActivity, "Change checks are running.", active);
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
  let coordinationSignature = "";
  let knowledgeWatchTimer: ReturnType<typeof setTimeout> | undefined;
  let pendingKnowledgeWatchSummary: string | undefined;
  let pendingKnowledgeWatchPaths: string[] = [];
  let knowledgeWatchQueue: Promise<void> = Promise.resolve();
  const idleTimeoutMs = options.idleTimeoutMs && options.idleTimeoutMs > 0 ? options.idleTimeoutMs : undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const transportActivity = createRuntimeActivityTracker(resetIdleTimer);
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
    const routeRequest = createRuntimeRouteHandler({
      rootDir,
      authToken,
      tracer,
      events,
      stateManager,
      projectTypesRuntime,
      typeProducerRuntime,
      changeCheckRunner,
      paths: () => paths,
      setPaths(nextPaths) {
        paths = nextPaths;
      },
      store: () => store,
      resetIdleTimer,
      refreshCurrentSnapshot,
      ensureProjectSnapshot,
      buildIndexedSnapshot,
      restartStore,
    });
    server = await serveRuntime({ host, port, routeRequest, beginActivity: beginTransportActivity });
    const pipeEndpoint =
      options.pipeEndpoint ??
      configuredPipeEndpoint ??
      localPipeEndpoint({ scope: "runtime", key: `${rootDir}:${options.statePath ?? ""}:${process.pid}:${port}` });
    pipeServer = await serveLocalProtocolPipe({
      endpoint: pipeEndpoint,
      routeRequest,
      host: "opencanon.runtime",
      maxFrameBytes: MaxRequestBodyBytes,
      beginActivity: beginTransportActivity,
    });
    resetIdleTimer();
  } catch (error) {
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

  async function ensureProjectSnapshot(summary: string): Promise<RuntimeSnapshot> {
    const snapshot = await refreshCurrentSnapshot();
    if (snapshot.files.length > 0) return snapshot;
    return await stateManager.rebuildAndPublish(summary);
  }

  async function buildIndexedSnapshot(summary: string, options: { force?: boolean; changedPaths?: string[] } = {}): Promise<RuntimeSnapshot> {
    const jobId = beginWorkerJob({
      kind: RuntimeWorkerJobKindValue.SemanticIndex,
      label: options.force ? "Rebuilding Project Knowledge" : "Indexing Project Knowledge",
      message: summary,
    });
    await withRuntimeBusyLifecycle(options.force ? "Project Knowledge rebuild is running." : "Project Knowledge indexing is running.", async () => {
      const manager = createKnowledgeIndexManager({ rootDir, store });
      await manager.index({
        force: options.force,
        changedPaths: options.changedPaths,
        onProgress(progress) {
          publishKnowledgeIndexProgress(jobId, progress);
        },
      });
    }).then(
      () =>
        finishWorkerJob(jobId, RuntimeWorkerJobStatusValue.Succeeded, {
          label: "Project Knowledge ready",
          message: summary,
        }),
      (error) => {
        finishWorkerJob(jobId, RuntimeWorkerJobStatusValue.Failed, {
          label: "Project Knowledge indexing failed",
          message: errorMessage(error),
        });
        throw error;
      },
    );
    return await stateManager.rebuildAndPublish(summary);
  }

  function scheduleKnowledgeRefreshForWatch(batch: WatcherEventBatch, summary: string | undefined): void {
    if (stopped || !summary) return;
    const existingIndex = store.readSemanticIndexStatus({ indexId: "project" }).index;
    if (!existingIndex || existingIndex.status === KnowledgeIndexStatus.Missing || existingIndex.status === KnowledgeIndexStatus.Failed) return;
    pendingKnowledgeWatchSummary = batch.stale
      ? "Project Knowledge source inventory changed; refreshing index."
      : knowledgeWatchSummary(batch.paths);
    pendingKnowledgeWatchPaths = batch.stale ? [] : [...new Set([...pendingKnowledgeWatchPaths, ...batch.paths])].sort();
    if (knowledgeWatchTimer) clearTimeout(knowledgeWatchTimer);
    knowledgeWatchTimer = setTimeout(() => {
      knowledgeWatchTimer = undefined;
      const queuedSummary = pendingKnowledgeWatchSummary;
      const queuedPaths = pendingKnowledgeWatchPaths;
      pendingKnowledgeWatchSummary = undefined;
      pendingKnowledgeWatchPaths = [];
      if (!queuedSummary || stopped) return;
      knowledgeWatchQueue = knowledgeWatchQueue
        .catch(() => undefined)
        .then(async () => {
          if (stopped) return;
          const currentIndex = store.readSemanticIndexStatus({ indexId: "project" }).index;
          if (!currentIndex || currentIndex.status === KnowledgeIndexStatus.Missing || currentIndex.status === KnowledgeIndexStatus.Failed) return;
          await buildIndexedSnapshot(queuedSummary, { changedPaths: queuedPaths });
        })
        .catch((error) => {
          events.broadcast(streamErrorEvent(`Project Knowledge update failed: ${errorMessage(error)}`));
        });
    }, KnowledgeWatchDebounceMs);
    if (typeof knowledgeWatchTimer === "object" && "unref" in knowledgeWatchTimer) {
      knowledgeWatchTimer.unref();
    }
  }

  function publishKnowledgeIndexProgress(jobId: string, progress: KnowledgeIndexProgress): void {
    updateWorkerJob(jobId, {
      label: progress.label,
      current: progress.current,
      total: progress.total,
      unit: progress.unit,
      message: progress.label,
    });
    events.broadcast(indexingEvent(progress.label, {
      phase: runtimeStreamPhaseForKnowledge(progress.phase),
      label: progress.label,
      current: progress.current,
      total: progress.total,
      unit: progress.unit,
      indeterminate: progress.current === undefined || progress.total === undefined,
    }));
  }

  function runtimeStreamPhaseForKnowledge(phase: KnowledgeIndexProgress["phase"]): RuntimeStreamProgress["phase"] {
    switch (phase) {
      case "scan":
      case "diff":
        return "file-discovery";
      case "chunk":
        return "chunking";
      case "embed":
        return "embedding";
      case "write":
      case "prewarm":
        return "product-graph";
      case "ready":
        return "ready";
    }
  }

  function startStoreWatcher(): void {
    try {
      store.project.startWatcher({ debounceMs: 250, bufferCapacity: 128 }, (batch) => {
        if (stopped) return;
        const summary = watcherBatchSummary(batch);
        projectTypesRuntime.scheduleForFiles(batch.paths, "Project authoring types updated after indexed files changed.");
        scheduleKnowledgeRefreshForWatch(batch, summary);
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

  function beginTransportActivity(): () => void {
    resetIdleTimer();
    const release = transportActivity.begin("runtime-request");
    return () => {
      release();
      resetIdleTimer();
    };
  }

  async function stopForIdle(): Promise<void> {
    if (stopped) return;
    if (transportActivity.count() > 0 || currentWorkerJob || changeCheckRunner.hasActiveWork() || stateManager.hasPendingWork()) {
      resetIdleTimer();
      return;
    }
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

  async function rebuildAndPublishNow(summary: string, _options: RuntimeRebuildOptions): Promise<RuntimeSnapshot> {
    const jobId = beginWorkerJob({
      kind: RuntimeWorkerJobKindValue.SemanticIndex,
      label: "Refreshing Project State",
      message: summary,
    });
    return withRuntimeBusyLifecycle(
      "Project state refresh is running.",
      () => tracer.span("runtime.snapshot.rebuild", { kind: SpanKind.TASK, attributes: { summary } }, async (span) => {
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
            message: "Building project map and reading Project Knowledge state.",
          });
          events.broadcast(indexingEvent("Building project map and reading Project Knowledge state.", {
            phase: "product-graph",
            label: "Linking definitions and context",
            current: next.definitionGraph.nodes.length,
            total: next.definitionGraph.nodes.length,
            unit: "nodes",
          }));
          validatorGraphRuntime?.recordCurrentSourceSignature();
          store.writeEvent(indexedEvent(next, summary));
          finishWorkerJob(jobId, RuntimeWorkerJobStatusValue.Succeeded, {
            label: "Project state ready",
            current: next.files.length,
            total: next.files.length,
            unit: "files",
            message: summary,
          });
          const publishedSnapshot = withProcessIdentity(next);
          events.broadcast(indexingEvent(summary, {
            phase: "ready",
            label: "Project state ready",
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
            label: "Project state refresh failed",
            message: errorMessage(error),
          });
          throw error;
        }
      }),
    );
  }

  async function withRuntimeBusyLifecycle<T>(message: string, work: () => Promise<T>): Promise<T> {
    const activity = Symbol(message);
    setRuntimeBusyActivity(activity, message, true);
    try {
      return await work();
    } finally {
      setRuntimeBusyActivity(activity, message, false);
    }
  }

  function setRuntimeBusyActivity(activity: symbol, message: string, active: boolean): void {
    if (active) runtimeBusyActivities.set(activity, message);
    else runtimeBusyActivities.delete(activity);
    syncRuntimeBusyLifecycle();
  }

  function syncRuntimeBusyLifecycle(): void {
    if (!runtimeRegistryPath) return;
    const entry = currentRuntimeRegistryEntry(runtimeRegistryPath);
    if (!entry) return;
    const messages = [...runtimeBusyActivities.values()];
    if (messages.length > 0) {
      const message = messages[messages.length - 1]!;
      if (entry.lifecycle.status !== ProcessLifecycleStatus.Busy || entry.lifecycle.message !== message) {
        setRuntimeLifecycleForLease(entry, createLifecycle(ProcessLifecycleStatus.Busy, message, entry.lifecycle.restart), runtimeRegistryPath);
      }
      return;
    }
    if (entry.lifecycle.status === ProcessLifecycleStatus.Busy) {
      setRuntimeLifecycleForLease(entry, createLifecycle(ProcessLifecycleStatus.Running, "Runtime health endpoint is ready.", entry.lifecycle.restart), runtimeRegistryPath);
    }
  }

  function currentRuntimeRegistryEntry(registryPath: string): RuntimeRegistryEntry | undefined {
    return (
      readRuntimeRegistry(registryPath).find(runtimeEntryMatchesCurrentProcess) ??
      maybeCurrentRuntimeEntry(readProjectRuntimeEntry(rootDir))
    );
  }

  function maybeCurrentRuntimeEntry(entry: RuntimeRegistryEntry | undefined): RuntimeRegistryEntry | undefined {
    return entry && runtimeEntryMatchesCurrentProcess(entry) ? entry : undefined;
  }

  function runtimeEntryMatchesCurrentProcess(entry: RuntimeRegistryEntry): boolean {
    return entry.rootDir === rootDir && entry.pid === process.pid && entry.leaseId === processIdentity.leaseId;
  }

  async function rebuildSnapshot(input: { cwd: string; store: ProjectStore }): Promise<RuntimeSnapshot> {
    try {
      return withProcessIdentity(await buildRuntimeSnapshot({
        cwd: rootDir,
        engine: prerequisites.engine,
        store: input.store,
        producerPolicy: InteractiveProducerPolicy,
        validationResultCache: stateManager.validationResultCache(),
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
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    if (producerReadyDebounce) clearTimeout(producerReadyDebounce);
    producerReadyDebounce = undefined;
    if (knowledgeWatchTimer) clearTimeout(knowledgeWatchTimer);
    knowledgeWatchTimer = undefined;
    pendingKnowledgeWatchSummary = undefined;
    pendingKnowledgeWatchPaths = [];
    stopStoreWatcher();
    stopCoordinationWatcher();
    projectTypesRuntime.stop();
    setLiveTypeFactsProviderFactory(undefined);
    setProjectAstFactsProviderFactory(undefined);
    fixtureAst.dispose();
    await typeProducerRuntime?.stop();
    await knowledgeWatchQueue.catch(() => undefined);
    await changeCheckRunner.stop();
    await stateManager.waitForIdle();
    stateManager.stop();
    events.close();
    await pipeServer?.stop(true);
    await server?.stop(true);
    await tracer.shutdown().catch(() => undefined);
    await storeResource.dispose();
    workerLease.release();
    await options.onStopped?.();
  }
}

function watcherBatchSummary(batch: WatcherEventBatch): string | undefined {
  if (batch.stale) return batch.reason ?? "Engine watcher requested a full reindex.";
  if (batch.paths.length === 0) return undefined;
  return batch.paths.length === 1 ? `Indexed changed file ${batch.paths[0]}.` : `Indexed ${batch.paths.length} changed files.`;
}

function knowledgeWatchSummary(paths: string[]): string {
  if (paths.length === 0) return "Project Knowledge source changed; refreshing index.";
  return paths.length === 1 ? `Project Knowledge source changed: ${paths[0]}.` : `Project Knowledge source changed in ${paths.length} files.`;
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
