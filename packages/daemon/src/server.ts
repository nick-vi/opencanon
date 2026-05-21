import {
  createHookFeedback,
  createPaths,
  createProfiler,
  formatOpenCanonDiagnostics,
  loadProjectContext,
  renderHookResponse,
  resource,
  runFeedback,
  runValidation,
  resolveRootDir,
  validateConfig,
  type FeedbackHost,
  type FixMode,
  type WatcherEventBatch,
} from "@opencanon/core";
import { buildDaemonSnapshot, buildRelatedCanon, daemonSnapshotFailure, gitDiffSnapshot, gitHistorySnapshot, type DaemonSnapshot } from "./snapshot.ts";
import { TreeScope, buildTreeResponse, filterTreeFiles, listProjectInventory, readFileResponse, treeScopeParam, validateCommitHash, validateOptionalRelativePaths, validateRelativePath, validateRelativePaths } from "./server-fs.ts";
import { StreamEventType, createEventBroadcaster, eventStream, indexedEvent, snapshotEvent } from "./server-events.ts";
import { assertDaemonPrerequisites, daemonSchemaVersion, renderPrerequisiteFailure, requiredBunVersion } from "./runtime.ts";
import { createDaemonStore, type DaemonStore } from "./state.ts";
import { readProjectSettings, writeProjectSettings } from "./settings.ts";
import { applyStudioValidator, listStudioFactories, listStudioValidators, previewStudioValidator, runStudioValidatorFixtures } from "./studio.ts";
import { assertSafeDaemonHost, createDaemonAuthToken, usableDaemonAuthToken } from "./auth.ts";
import { listProjects } from "./project-summary.ts";
import { ApiPathPrefix, ApiRoute, UrlSearchParam, diagnostic, diagnosticCodes, json, validateDaemonAuth, validateMethod } from "./routes.ts";
import { serveUiAsset } from "./ui-assets.ts";
import { createValidatorGraphRuntime } from "./validator-graph-runtime.ts";

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

export type DaemonServerOptions = {
  cwd?: string;
  host?: string;
  port?: number;
  serveUi?: boolean;
  statePath?: string;
  authToken?: string;
  allowRemote?: boolean;
};

export type DaemonServer = {
  url: string;
  authToken: string;
  stop(): Promise<void>;
};

export async function startOpenCanonDaemon(options: DaemonServerOptions = {}): Promise<DaemonServer> {
  const cwd = options.cwd ?? process.cwd();
  const rootDir = resolveRootDir(cwd);
  const host = options.host ?? "127.0.0.1";
  assertSafeDaemonHost(host, options.allowRemote);
  const authToken = usableDaemonAuthToken(options.authToken) ?? usableDaemonAuthToken(process.env.OPENCANON_DAEMON_TOKEN) ?? createDaemonAuthToken();
  const port = options.port ?? 4767;
  const paths = createPaths(rootDir);
  const configDiagnostics = validateConfig(paths);
  if (configDiagnostics.length > 0) {
    throw new Error(`Invalid OpenCanon config:\n${configDiagnostics.map((diagnostic) => `- ${diagnostic}`).join("\n")}`);
  }
  const prerequisites = assertDaemonPrerequisites();
  const storeResource = resource({
    init() {
      return createDaemonStore({ rootDir, paths, engine: prerequisites.engine, statePath: options.statePath });
    },
    dispose: (store) => store.close(),
  });
  let store = await storeResource.get();

  let snapshot = await buildDaemonSnapshot({
    cwd: rootDir,
    engine: prerequisites.engine,
    store,
  });
  const events = createEventBroadcaster();
  const validatorGraphRuntime = createValidatorGraphRuntime({
    rootDir,
    paths,
    events,
    initialDependencyFiles: snapshot.health.validatorGraph?.dependencyFiles,
    rebuildAndPublish,
    isStopped: () => stopped,
  });
  let projectInventory = listProjectInventory(rootDir);
  let watchRebuildInFlight: Promise<void> | undefined;
  let queuedWatchSummary: string | undefined;
  let stopped = false;

  let server: ReturnType<typeof Bun.serve>;
  try {
    startStoreWatcher();
    snapshot = refreshSnapshotWatcherStatus(snapshot, store);
    server = Bun.serve({
      hostname: host,
      idleTimeout: 255,
      port,
      async fetch(request) {
        const url = new URL(request.url);
        const methodValidation = validateMethod(url.pathname, request.method);
        if (!methodValidation.ok) return json(methodValidation.error, 405);
        const authValidation = validateDaemonAuth(request, url, authToken);
        if (!authValidation.ok) return json(authValidation.error, 401);
        if (url.pathname === ApiRoute.Health) {
          snapshot = await validatorGraphRuntime.refreshIfChanged(snapshot);
          return json({ ok: true, data: snapshot.health });
        }
        if (url.pathname === ApiRoute.State) {
          snapshot = await validatorGraphRuntime.refreshIfChanged(snapshot);
          return json({ ok: true, data: snapshot.state });
        }
        if (url.pathname === ApiRoute.Snapshot) {
          snapshot = await validatorGraphRuntime.refreshIfChanged(snapshot);
          return json({ ok: true, data: snapshot });
        }
        if (url.pathname === ApiRoute.CanonRelated) {
          snapshot = await validatorGraphRuntime.refreshIfChanged(snapshot);
          const safeFiles = validateOptionalRelativePaths(url.searchParams.getAll(UrlSearchParam.File));
          if (!safeFiles.ok) return json(safeFiles.error, 400);
          const currentSnapshot = snapshot;
          const query = {
            files: safeFiles.paths,
            topics: url.searchParams.getAll(UrlSearchParam.Topic).filter(Boolean),
            decisionIds: url.searchParams.getAll(UrlSearchParam.DecisionId).filter(Boolean),
            validatorIds: url.searchParams.getAll(UrlSearchParam.ValidatorId).filter(Boolean),
            findingIds: url.searchParams.getAll(UrlSearchParam.FindingId).filter(Boolean),
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
          return eventStream(events.connect(snapshotEvent(snapshot, "Connected to daemon stream.")));
        }
        if (url.pathname === ApiRoute.Events)
          return json({
            ok: true,
            data: store.listEvents(numberParam(url, UrlSearchParam.Limit, 50)),
          });
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
        if (url.pathname === ApiRoute.Validate && request.method === "POST") {
          return json({ ok: true, data: await validateFromDaemon(rootDir, request) });
        }
        if (url.pathname === ApiRoute.Feedback && request.method === "POST") {
          return json({ ok: true, data: await feedbackFromDaemon(rootDir, request) });
        }
        if (url.pathname === ApiRoute.HookFeedback && request.method === "POST") {
          return json({ ok: true, data: await hookFeedbackFromDaemon(rootDir, request) });
        }
        if (url.pathname === ApiRoute.Index && request.method === "POST") {
          snapshot = await rebuildAndPublish("Manual reindex completed.");
          return json({ ok: true, data: snapshot });
        }
        if (url.pathname === ApiRoute.Settings) {
          if (request.method === "GET") return json({ ok: true, data: readProjectSettings(rootDir) });
          const result = writeProjectSettings(rootDir, await readJsonBody(request));
          if (!result.ok) return json({ ok: false, diagnostics: result.diagnostics }, 400);
          await restartStore();
          snapshot = await rebuildAndPublish("Project settings saved.");
          return json({ ok: true, data: result.settings });
        }
        if (url.pathname === ApiRoute.StudioFactories) {
          return json({ ok: true, data: listStudioFactories() });
        }
        if (url.pathname === ApiRoute.StudioValidators) {
          return json({ ok: true, data: await listStudioValidators(rootDir) });
        }
        if (url.pathname === ApiRoute.StudioValidatorsPreview && request.method === "POST") {
          const result = previewStudioValidator(rootDir, await readJsonBody(request));
          if (!result.ok) return json({ ok: false, diagnostics: result.diagnostics }, 400);
          return json({ ok: true, data: result.preview });
        }
        if (url.pathname === ApiRoute.StudioValidatorsRunFixtures && request.method === "POST") {
          const result = await runStudioValidatorFixtures(rootDir, await readJsonBody(request));
          if (!result.ok) return json({ ok: false, diagnostics: result.diagnostics }, 400);
          return json({ ok: true, data: result.run });
        }
        if (url.pathname === ApiRoute.StudioValidatorsApply && request.method === "POST") {
          const result = await applyStudioValidator(rootDir, await readJsonBody(request));
          if (!result.ok) return json({ ok: false, diagnostics: result.diagnostics }, 400);
          snapshot = await rebuildAndPublish("Validator Studio applied a rule.");
          return json({ ok: true, data: result.result });
        }
        if (url.pathname === ApiRoute.SupervisorProjects) {
          return json({ ok: true, data: await listProjects(rootDir, snapshot) });
        }
        if (url.pathname === ApiRoute.FsTree) {
          const requested = url.searchParams.get(UrlSearchParam.Path) ?? "";
          const safe = validateRelativePath(requested, { allowEmpty: true });
          if (!safe.ok) return json(safe.error, 400);
          const scope = treeScopeParam(url);
          const query = url.searchParams.get(UrlSearchParam.Query) ?? "";
          const showDotEntries = url.searchParams.get(UrlSearchParam.Dot) !== "0";
          let sourceFiles = snapshot.files;
          if (scope === TreeScope.All) {
            if (!projectInventory.ok) return json(projectInventory.error, 500);
            sourceFiles = projectInventory.files;
          }
          return json({
            ok: true,
            data: buildTreeResponse(safe.path, sourceFiles, snapshot, { query, showDotEntries }),
          });
        }
        if (url.pathname === ApiRoute.FsFile) {
          const requested = url.searchParams.get(UrlSearchParam.Path) ?? "";
          const safe = validateRelativePath(requested, { allowEmpty: false });
          if (!safe.ok) return json(safe.error, 400);
          return await readFileResponse(rootDir, safe.path);
        }
        if (url.pathname === ApiRoute.Findings) {
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
        if (url.pathname.startsWith(ApiPathPrefix)) {
          return json(diagnostic(diagnosticCodes.invalidDaemonResponse, `Unknown daemon route: ${url.pathname}.`), 404);
        }
        if (options.serveUi ?? true) return serveUiAsset(request, url, authToken, Boolean(options.allowRemote));
        return new Response("OpenCanon daemon", { status: 200 });
      },
    });
  } catch (error) {
    store.project.stopWatcher();
    events.close();
    await storeResource.dispose();
    throw error;
  }

  function scheduleWatchRebuild(summary: string): void {
    if (stopped) return;
    queuedWatchSummary = summary;
    if (watchRebuildInFlight) return;
    watchRebuildInFlight = runQueuedWatchRebuilds().finally(() => {
      watchRebuildInFlight = undefined;
      if (queuedWatchSummary) scheduleWatchRebuild(queuedWatchSummary);
    });
  }

  async function runQueuedWatchRebuilds(): Promise<void> {
    while (queuedWatchSummary) {
      const summary = queuedWatchSummary;
      queuedWatchSummary = undefined;
      try {
        snapshot = await rebuildAndPublish(summary);
      } catch (error) {
        events.broadcast({
          type: StreamEventType.Indexing,
          timestamp: new Date().toISOString(),
          summary: formatOpenCanonDiagnostics(daemonSnapshotFailure(error).diagnostics),
        });
      }
    }
  }

  function startStoreWatcher(): void {
    store.project.startWatcher({ debounceMs: 250, bufferCapacity: 128 }, (batch) => {
      if (stopped) return;
      const summary = watcherBatchSummary(batch);
      if (summary) scheduleWatchRebuild(summary);
    });
  }

  async function restartStore(): Promise<void> {
    if (watchRebuildInFlight) await watchRebuildInFlight.catch(() => undefined);
    store.project.stopWatcher();
    await storeResource.dispose();
    store = await storeResource.get();
    startStoreWatcher();
  }

  async function rebuildAndPublish(summary: string): Promise<DaemonSnapshot> {
    events.broadcast({
      type: StreamEventType.Indexing,
      timestamp: new Date().toISOString(),
      summary: "Indexing repository.",
    });
    const next = await rebuildSnapshot({ cwd: rootDir, store });
    validatorGraphRuntime.recordCurrentSourceSignature();
    projectInventory = listProjectInventory(rootDir);
    store.writeEvent(indexedEvent(next, summary));
    events.broadcast(snapshotEvent(next, summary));
    return next;
  }

  async function rebuildSnapshot(input: { cwd: string; store: DaemonStore }): Promise<DaemonSnapshot> {
    try {
      return await buildDaemonSnapshot({
        cwd: rootDir,
        engine: prerequisites.engine,
        store: input.store,
      });
    } catch (error) {
      throw new Error(formatOpenCanonDiagnostics(daemonSnapshotFailure(error).diagnostics));
    }
  }

  return {
    url: `http://${host}:${server.port}`,
    authToken,
    async stop() {
      stopped = true;
      store.project.stopWatcher();
      if (watchRebuildInFlight) await watchRebuildInFlight.catch(() => undefined);
      events.close();
      server.stop(true);
      await storeResource.dispose();
    },
  };
}

function watcherBatchSummary(batch: WatcherEventBatch): string | undefined {
  if (batch.stale) return batch.reason ?? "Engine watcher requested a full reindex.";
  if (batch.paths.length === 0) return undefined;
  return batch.paths.length === 1 ? `Indexed changed file ${batch.paths[0]}.` : `Indexed ${batch.paths.length} changed files.`;
}

function refreshSnapshotWatcherStatus(snapshot: DaemonSnapshot, store: DaemonStore): DaemonSnapshot {
  const health = { ...snapshot.health, watcher: store.project.status().watcher };
  return { ...snapshot, health, state: { ...snapshot.state, health } };
}

async function validateFromDaemon(rootDir: string, request: Request) {
  const body = await readJsonBody(request);
  const project = await loadProjectContext(rootDir);
  const profiler = createProfiler(booleanBodyValue(body.profile));
  return await runValidation({
    rootDir: project.rootDir,
    paths: project.paths,
    decisions: project.decisions,
    validators: project.validators,
    files: stringArrayBodyValue(body.files),
    topics: stringArrayBodyValue(body.topics),
    validatorIds: stringArrayBodyValue(body.validatorIds),
    project: booleanBodyValue(body.project),
    fixMode: fixModeBodyValue(body.fixMode),
    dryRun: booleanBodyValue(body.dryRun),
    profiler,
  });
}

async function feedbackFromDaemon(rootDir: string, request: Request) {
  const body = await readJsonBody(request);
  return await runFeedback({
    cwd: rootDir,
    files: stringArrayBodyValue(body.files),
    host: feedbackHostBodyValue(body.host),
    sessionId: stringBodyValue(body.sessionId),
    turnId: stringBodyValue(body.turnId),
    dedupeScope: feedbackDedupeScopeBodyValue(body.dedupeScope),
  });
}

async function hookFeedbackFromDaemon(rootDir: string, request: Request) {
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

function feedbackHostBodyValue(value: unknown): FeedbackHost {
  if (value === FeedbackHostValue.Codex || value === FeedbackHostValue.Claude || value === FeedbackHostValue.OpenCode || value === FeedbackHostValue.Manual) return value;
  return FeedbackHostValue.Manual;
}

function feedbackDedupeScopeBodyValue(value: unknown): "off" | "turn" | "session" | undefined {
  if (value === "off" || value === "turn" || value === "session") return value;
  return undefined;
}

export async function checkDaemonPrerequisites(): Promise<string> {
  try {
    const prerequisites = assertDaemonPrerequisites();
    const engine = prerequisites.engine.version();
    return [
      "# OpenCanon Daemon Check",
      "",
      `Bun: ${prerequisites.bunVersion} (required ${requiredBunVersion})`,
      `Engine: ${engine.engineVersion} (package ${engine.packageVersion}, NAPI ${engine.napiVersion})`,
      `Daemon schema: ${daemonSchemaVersion}`,
      `Engine schema: ${engine.schemaVersion}`,
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

function validateRelatedSelectors(
  snapshot: DaemonSnapshot,
  query: { decisionIds: string[]; validatorIds: string[]; findingIds: string[] },
): { status: number; error: { ok: false; diagnostics: unknown[] } } | undefined {
  const missingDecision = query.decisionIds.find((id) => !snapshot.decisions.some((decision) => decision.id === id));
  if (missingDecision) return { status: 404, error: diagnostic(diagnosticCodes.invalidDaemonResponse, `Unknown decision id: ${missingDecision}.`) };
  const missingValidator = query.validatorIds.find((id) => !snapshot.validators.some((validator) => validator.id === id));
  if (missingValidator) return { status: 404, error: diagnostic(diagnosticCodes.invalidDaemonResponse, `Unknown validator id: ${missingValidator}.`) };
  const missingFinding = query.findingIds.find((id) => !snapshot.findings.some((finding) => finding.id === id));
  if (missingFinding) return { status: 404, error: diagnostic(diagnosticCodes.invalidDaemonResponse, `Unknown finding id: ${missingFinding}.`) };
  return undefined;
}
