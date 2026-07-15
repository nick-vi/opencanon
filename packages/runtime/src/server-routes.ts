import { SpanKind, type SimpleTracer } from "@opencanon/observability";
import {
  createOpenCanonDiagnostic,
  ChangeCheckRunEventType,
  ChangeCheckRunStatusSchema,
  ChangeTaskEventType,
  createPaths,
  createValidationResultCache,
  buildDoctorReport,
  deriveChangeWorkQueue,
  loadPendingCommitGates,
  loadProjectContext,
  normalizeProducerStatusesForProject,
  resolveProducerStatuses,
  validateChangeLifecycleTransition,
  type CanonEvent,
  type SemanticIndexSnapshot,
} from "@opencanon/core";
import { buildProjectSummary, buildRelatedCanon, gitDiffSnapshot, gitHistorySnapshot, refreshChangeActivitySnapshot, type RuntimeSnapshot } from "./snapshot.ts";
import { TreeScope, buildTreeResponse, readFileResponse, treeScopeParam, validateCommitHash, validateOptionalRelativePaths, validateRelativePath, validateRelativePaths } from "./server-fs.ts";
import { eventStream, operationEvent, snapshotEvent, type EventBroadcaster } from "./server-events.ts";
import { isAuthorizedRuntimeRequest } from "./auth.ts";
import { readProjectSettings, writeProjectSettings } from "./settings.ts";
import { applyAuthoringValidator, listAuthoringFactories, listAuthoringValidators, previewAuthoringValidator, runAuthoringValidatorFixtures } from "./authoring.ts";
import { listProjects } from "./project-summary.ts";
import { askProjectContext, listProjectContextChunks, projectContextBacklinks, projectContextCoverage, searchProjectContext } from "./project-context.ts";
import { ApiPathPrefix, ApiRoute, ProjectIndexResponseMode, UrlSearchParam, diagnostic, diagnosticCodes, diagnosticsFailure, json, validateRuntimeAuth, validateMethod } from "./routes.ts";
import type { RuntimeStateManager } from "./state-manager.ts";
import type { ProjectStore } from "./state.ts";
import type { createProjectTypesRuntime } from "./project-types-runtime.ts";
import type { createTypeProducerRuntime } from "./type-producer/runtime.ts";
import type { ChangeCheckRunner } from "./change-check-runner.ts";
import {
  activeTaskLeaseSummaries,
  listWorktreeOverview,
} from "./worktree-coordination.ts";
import { buildContextPacket } from "./server-context-packet.ts";
import { canonHistoryFromRuntime } from "./server-history.ts";
import { listChangeEvents, listCompleteChangeHistories, listRuntimeEvents, sameCanonEventRequest, writeRuntimeEvent } from "./server-canon-events.ts";
import {
  ChangeEventType,
  applyTaskOwnershipEvent,
  createChangeCheckEvent,
  parseChangeEventRequest,
  parseRunChangeCheckRequest,
} from "./server-change-runtime.ts";
import {
  approveCommitGateFromRuntime,
  feedbackFromRuntime,
  hookFeedbackFromRuntime,
  readJsonBody,
  runtimeInputDiagnostic,
  stringArrayBodyValue,
  stringBodyValue,
  validateFromRuntime,
} from "./server-runtime-actions.ts";
import {
  codeGraphDirectionParam,
  nonNegativeNumberParam,
  numberParam,
  optionalRelativePathParam,
  optionalStringParam,
  validateRelatedSelectors,
} from "./server-query.ts";
import type { KnowledgeQueryRuntime } from "./knowledge-query-runtime.ts";

type RuntimePaths = ReturnType<typeof createPaths>;

const SemanticIndexReadinessStatus = {
  Ready: "ready",
} as const;

export type RuntimeRouteHandlerInput = {
  rootDir: string;
  authToken: string;
  tracer: SimpleTracer;
  events: EventBroadcaster;
  stateManager: RuntimeStateManager;
  projectTypesRuntime: ReturnType<typeof createProjectTypesRuntime>;
  typeProducerRuntime?: ReturnType<typeof createTypeProducerRuntime>;
  changeCheckRunner: ChangeCheckRunner;
  knowledgeQueryRuntime: KnowledgeQueryRuntime;
  paths(): RuntimePaths;
  setPaths(paths: RuntimePaths): void;
  store(): ProjectStore;
  resetIdleTimer(): void;
  refreshCurrentSnapshot(): Promise<RuntimeSnapshot>;
  ensureProjectSnapshot(summary: string): Promise<RuntimeSnapshot>;
  buildIndexedSnapshot(summary: string, options?: { force?: boolean; changedPaths?: string[] }): Promise<RuntimeSnapshot>;
  restartStore(): Promise<void>;
};

export function createRuntimeRouteHandler(input: RuntimeRouteHandlerInput): (request: Request) => Promise<Response> {
  const { rootDir, authToken, tracer, events, stateManager, projectTypesRuntime, typeProducerRuntime, changeCheckRunner, knowledgeQueryRuntime, resetIdleTimer, refreshCurrentSnapshot, ensureProjectSnapshot, buildIndexedSnapshot, restartStore } = input;
  let paths = input.paths();
  const currentStore = () => input.store();

  const semanticContextSnapshot = async (): Promise<RuntimeSnapshot> => await refreshCurrentSnapshot();

  const semanticIndexNotReadyResponse = (snapshot: RuntimeSnapshot): Response | undefined => {
    const index = snapshot.state.semanticIndex ?? snapshot.semanticIndex;
    if (semanticIndexReady(index)) return undefined;
    const details = semanticIndexDiagnosticDetails(index);
    return json(
      diagnosticsFailure([
        createOpenCanonDiagnostic({
          code: diagnosticCodes.semanticIndexNotReady,
          message: "Project Knowledge is not ready. Run opencanon project index before using Search, Ask, Chunks, or Coverage.",
          details,
          action: "Run opencanon project index to build Project Knowledge explicitly.",
        }),
      ], diagnosticCodes.semanticIndexNotReady),
      409,
    );
  };

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
        return json({ ok: true, data: { ...snapshot.state, lifecycle: stateManager.lifecycle() } });
      }
      if (url.pathname === ApiRoute.Snapshot) {
        const snapshot = await ensureProjectSnapshot("Snapshot requested current project state.");
        return json({ ok: true, data: snapshot });
      }
      if (url.pathname === ApiRoute.ProjectSummary) {
        const snapshot = await refreshCurrentSnapshot();
        return json({ ok: true, data: buildProjectSummary({ rootDir, snapshot, store: currentStore(), lifecycle: stateManager.lifecycle() }) });
      }
      if (url.pathname === ApiRoute.ContextStatus) {
        const snapshot = await refreshCurrentSnapshot();
        return json({ ok: true, data: { index: snapshot.state.semanticIndex ?? snapshot.semanticIndex } });
      }
      if (url.pathname === ApiRoute.CodeSymbols) {
        const safePath = optionalRelativePathParam(url, UrlSearchParam.Path);
        if (!safePath.ok) return json(safePath.error, 400);
        const sourceFiles = stateManager.currentSnapshot().state.files;
        const limit = Math.min(1000, numberParam(url, UrlSearchParam.Limit, 50));
        if (url.searchParams.get(UrlSearchParam.References) === "1") {
          const result = currentStore().project.searchReferences({
            query: optionalStringParam(url, UrlSearchParam.Query),
            path: safePath.path,
            source: optionalStringParam(url, UrlSearchParam.Source),
            kind: optionalStringParam(url, UrlSearchParam.Kind),
            limit,
          });
          return json({ ok: true, data: { sourceFiles, references: result.references } });
        }
        const result = currentStore().project.searchSymbols({
          query: optionalStringParam(url, UrlSearchParam.Query),
          path: safePath.path,
          kind: optionalStringParam(url, UrlSearchParam.Kind),
          limit: Math.min(500, limit),
        });
        return json({ ok: true, data: { sourceFiles, symbols: result.symbols } });
      }
      if (url.pathname === ApiRoute.CodeGraph) {
        const safePath = optionalRelativePathParam(url, UrlSearchParam.Path);
        if (!safePath.ok) return json(safePath.error, 400);
        const direction = codeGraphDirectionParam(url);
        if (!direction.ok) return json(direction.error, 400);
        const result = currentStore().project.searchGraphEdges({
          query: optionalStringParam(url, UrlSearchParam.Query),
          symbolId: optionalStringParam(url, UrlSearchParam.SymbolId),
          path: safePath.path,
          kind: optionalStringParam(url, UrlSearchParam.Kind),
          direction: direction.direction,
          limit: Math.min(1000, numberParam(url, UrlSearchParam.Limit, 50)),
        });
        return json({ ok: true, data: { sourceFiles: stateManager.currentSnapshot().state.files, edges: result.edges } });
      }
      if (url.pathname === ApiRoute.ContextChunks) {
        const snapshot = await semanticContextSnapshot();
        const notReady = semanticIndexNotReadyResponse(snapshot);
        if (notReady) return notReady;
        const pathFilter = validateOptionalRelativePaths(url.searchParams.getAll(UrlSearchParam.Path));
        if (!pathFilter.ok) return json(pathFilter.error, 400);
        return json({
          ok: true,
          data: listProjectContextChunks({
            store: currentStore(),
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
          const snapshot = await semanticContextSnapshot();
          const notReady = semanticIndexNotReadyResponse(snapshot);
          if (notReady) return notReady;
          const query = (url.searchParams.get(UrlSearchParam.Query) ?? "").trim();
          const limit = Math.min(100, numberParam(url, UrlSearchParam.Limit, 20));
          const pathFilter = validateOptionalRelativePaths(url.searchParams.getAll(UrlSearchParam.Path));
          if (!pathFilter.ok) return json(pathFilter.error, 400);
          try {
            const vector = await knowledgeQueryRuntime.query(query, request.signal);
            const result = searchProjectContext({
              store: currentStore(),
              snapshot,
              query: { query, paths: pathFilter.paths, limit },
              vector,
            });
            span.setOutput({ results: result.results.length, indexed: Boolean(result.index) });
            return json({ ok: true, data: result });
          } catch (error) {
            return json(
              diagnosticsFailure([
                createOpenCanonDiagnostic({
                  code: diagnosticCodes.inferenceError,
                  message: `Could not search Project Knowledge: ${error instanceof Error ? error.message : String(error)}`,
                }),
              ], diagnosticCodes.inferenceError),
              500,
            );
          }
        });
      }
      if (url.pathname === ApiRoute.ContextAsk) {
        return await tracer.span("project-context.ask", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, async (span) => {
          const snapshot = await semanticContextSnapshot();
          const notReady = semanticIndexNotReadyResponse(snapshot);
          if (notReady) return notReady;
          const question = (url.searchParams.get(UrlSearchParam.Query) ?? "").trim();
          if (!question) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "Project Knowledge Ask requires a query."), 400);
          try {
            const vector = await knowledgeQueryRuntime.query(question, request.signal);
            const result = askProjectContext({ store: currentStore(), snapshot, question, vector });
            span.setOutput({ evidence: result.evidence.length, indexed: Boolean(result.index) });
            return json({ ok: true, data: result });
          } catch (error) {
            return json(
              diagnosticsFailure([
                createOpenCanonDiagnostic({
                  code: diagnosticCodes.inferenceError,
                  message: `Could not ask Project Knowledge: ${error instanceof Error ? error.message : String(error)}`,
                }),
              ], diagnosticCodes.inferenceError),
              500,
            );
          }
        });
      }
      if (url.pathname === ApiRoute.ContextCoverage) {
        const snapshot = await semanticContextSnapshot();
        const notReady = semanticIndexNotReadyResponse(snapshot);
        if (notReady) return notReady;
        return json({ ok: true, data: projectContextCoverage({ store: currentStore(), snapshot }) });
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
          knowledgeInspection: { kind: "available", index: currentStore().readSemanticIndexStatus({ indexId: "project" }).index },
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
            events: listChangeEvents(rootDir, currentStore(), { limit: Math.min(100, numberParam(url, UrlSearchParam.Limit, 25)) }),
            limit: Math.min(100, numberParam(url, UrlSearchParam.Limit, 25)),
          }),
        });
      }
      if (url.pathname === ApiRoute.ContextBacklinks) {
        const snapshot = await refreshCurrentSnapshot();
        const query = (url.searchParams.get(UrlSearchParam.Query) ?? url.searchParams.get(UrlSearchParam.Id) ?? url.searchParams.get(UrlSearchParam.Path) ?? "").trim();
        if (!query) return json(diagnostic(diagnosticCodes.invalidRuntimeResponse, "Project Knowledge backlinks requires query, id, or path."), 400);
        return json({ ok: true, data: projectContextBacklinks({ snapshot, query }) });
      }
      if (url.pathname === ApiRoute.Changes) {
        const snapshot = await refreshCurrentSnapshot();
        return json({ ok: true, data: snapshot.changes });
      }
      if (url.pathname === ApiRoute.ChangeReady) {
        const changeCatalog = stateManager.currentChangeCatalog();
        const histories = listCompleteChangeHistories(rootDir, currentStore(), changeCatalog.changes.map((change) => change.id));
        return json({ ok: true, data: deriveChangeWorkQueue(changeCatalog.changes, histories.events, { leases: activeTaskLeaseSummaries(rootDir) }) });
      }
      if (url.pathname === ApiRoute.Worktrees) {
        return json({ ok: true, data: listWorktreeOverview(rootDir) });
      }
      if (url.pathname === ApiRoute.ChangeCheckRuns) {
        if (request.method === "GET") {
          const runId = url.searchParams.get(UrlSearchParam.RunId)?.trim();
          if (runId) {
            const rawAfter = url.searchParams.get(UrlSearchParam.After);
            const parsedAfter = rawAfter === null ? undefined : Number(rawAfter);
            if (parsedAfter !== undefined && (!Number.isInteger(parsedAfter) || parsedAfter < 0)) {
              return json(diagnosticsFailure([runtimeInputDiagnostic("after must be a non-negative integer.")]), 400);
            }
            const afterSequence = parsedAfter;
            const snapshot = changeCheckRunner.describe(runId, afterSequence);
            if (!snapshot) return json(diagnosticsFailure([runtimeInputDiagnostic(`Unknown Change check run: ${runId}.`)]), 404);
            return json({ ok: true, data: snapshot });
          }
          const rawStatus = url.searchParams.get(UrlSearchParam.Status)?.trim();
          const status = rawStatus ? ChangeCheckRunStatusSchema.safeParse(rawStatus) : undefined;
          if (status && !status.success) {
            return json(diagnosticsFailure([runtimeInputDiagnostic(`Unknown Change check run status: ${rawStatus}.`)]), 400);
          }
          const rawLimit = url.searchParams.get(UrlSearchParam.Limit);
          const parsedLimit = rawLimit === null ? 20 : Number(rawLimit);
          if (!Number.isInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
            return json(diagnosticsFailure([runtimeInputDiagnostic("limit must be an integer from 1 to 100.")]), 400);
          }
          const limit = parsedLimit;
          return json({
            ok: true,
            data: {
              runs: changeCheckRunner.list({
                mode: "recent",
                limit,
                ...(status?.success ? { status: status.data } : {}),
              }),
            },
          });
        }
        const project = await loadProjectContext(rootDir);
        const parsed = parseRunChangeCheckRequest(await readJsonBody(request), project.changes);
        if (!parsed.ok) return json(diagnosticsFailure(parsed.diagnostics), 400);
        const started = changeCheckRunner.start({ project, change: parsed.change, task: parsed.task, checks: parsed.checks, actor: parsed.actor });
        if (!started.ok) {
          const { activeCount, requestedCount, capacity } = started.admission;
          return json(
            diagnosticsFailure(
              [
                createOpenCanonDiagnostic({
                  code: diagnosticCodes.operationCapacityExceeded,
                  message: "Project operation capacity is full; no runs from this request were admitted.",
                  details: [`Active runs: ${activeCount}.`, `Requested runs: ${requestedCount}.`, `Capacity: ${capacity}.`],
                  action: "Wait for an active run to finish or cancel one, then retry the whole request.",
                }),
              ],
              diagnosticCodes.operationCapacityExceeded,
            ),
            429,
          );
        }
        return json({ ok: true, data: { batchId: started.batchId, runs: started.runs } }, 202);
      }
      if (url.pathname === ApiRoute.ChangeCheckRunsCancel) {
        const body = await readJsonBody(request);
        const runId = stringBodyValue(body.runId)?.trim();
        if (!runId) return json(diagnosticsFailure([runtimeInputDiagnostic("runId is required.")]), 400);
        const cancelled = await changeCheckRunner.cancel(runId);
        if (!cancelled.ok) {
          return json(
            diagnosticsFailure(
              [
                createOpenCanonDiagnostic({
                  code: diagnosticCodes.lifecycleConflict,
                  message: `Change check run ${runId} is owned by runtime namespace ${cancelled.run.executor.runtimeNamespace}.`,
                  action: "Use the OpenCanon service namespace that started the run or wait for that run to finish.",
                }),
              ],
              diagnosticCodes.lifecycleConflict,
            ),
            409,
          );
        }
        if (!cancelled.run) return json(diagnosticsFailure([runtimeInputDiagnostic(`Unknown Change check run: ${runId}.`)]), 404);
        const snapshot = changeCheckRunner.describe(runId);
        if (!snapshot) return json(diagnosticsFailure([runtimeInputDiagnostic(`Unknown Change check run: ${runId}.`)]), 404);
        return json({ ok: true, data: snapshot });
      }
      if (url.pathname === ApiRoute.ChangeEvents) {
        if (request.method === "GET") {
          const changeId = url.searchParams.get(UrlSearchParam.ChangeId) ?? undefined;
          const taskId = url.searchParams.get(UrlSearchParam.TaskId) ?? undefined;
          const checkId = url.searchParams.get(UrlSearchParam.CheckId) ?? undefined;
          return json({ ok: true, data: listChangeEvents(rootDir, currentStore(), { changeId, taskId, checkId, limit: numberParam(url, UrlSearchParam.Limit, 50) }) });
        }
        const changeCatalog = stateManager.currentChangeCatalog();
        const parsed = parseChangeEventRequest(await readJsonBody(request), changeCatalog.changes);
        if (!parsed.ok) return json(diagnosticsFailure(parsed.diagnostics), 400);
        const change = changeCatalog.changes.find((item) => item.id === parsed.event.changeIds[0]);
        if (!change) return json(diagnosticsFailure([runtimeInputDiagnostic(`Unknown Change ${parsed.event.changeIds[0]}.`)]), 404);
        const history = listCompleteChangeHistories(rootDir, currentStore(), [change.id]);
        const existing = history.events.find((event) => event.id === parsed.event.id);
        if (existing) {
          if (!sameCanonEventRequest(existing, parsed.event)) {
            return json(
              diagnosticsFailure([
                createOpenCanonDiagnostic({
                  code: diagnosticCodes.lifecycleConflict,
                  message: `Canon event id ${parsed.event.id} is already committed with different content.`,
                }),
              ], diagnosticCodes.lifecycleConflict),
              409,
            );
          }
          return json({ ok: true, data: { event: existing, changes: stateManager.currentSnapshot().changes } });
        }
        const leases = activeTaskLeaseSummaries(rootDir);
        const activeLease = parsed.event.type === ChangeTaskEventType.Claimed
          ? leases.find((lease) => lease.changeId === change.id && lease.taskId === parsed.event.taskIds[0])
          : undefined;
        if (activeLease && parsed.event.actor !== activeLease.agentId) {
          const ownership = applyTaskOwnershipEvent(rootDir, parsed.event);
          if (!ownership.ok) return json(diagnosticsFailure(ownership.diagnostics), ownership.status);
        }
        const transitionIssues = validateChangeLifecycleTransition({
          change,
          event: parsed.event,
          events: history.events,
          leases,
        });
        if (transitionIssues.length > 0) {
          const diagnostics = transitionIssues.map((message) => createOpenCanonDiagnostic({ code: diagnosticCodes.lifecycleConflict, message }));
          return json(diagnosticsFailure(diagnostics, diagnosticCodes.lifecycleConflict), 409);
        }
        const ownership = applyTaskOwnershipEvent(rootDir, parsed.event);
        if (!ownership.ok) return json(diagnosticsFailure(ownership.diagnostics), ownership.status);
        writeRuntimeEvent(rootDir, currentStore(), ownership.event);
        const snapshot = refreshChangeActivitySnapshot({
          snapshot: stateManager.currentSnapshot(),
          changeCatalog,
          store: currentStore(),
        });
        stateManager.setSnapshot(snapshot);
        events.broadcast(snapshotEvent(snapshot, ownership.event.summary));
        return json({ ok: true, data: { event: ownership.event, changes: snapshot.changes } });
      }
      if (url.pathname === ApiRoute.CanonRelated) {
        const body = request.method === "POST" ? await readJsonBody(request) : {};
        const requestedFiles = request.method === "POST" ? stringArrayBodyValue(body.files) : url.searchParams.getAll(UrlSearchParam.File);
        const safeFiles = validateOptionalRelativePaths(requestedFiles);
        if (!safeFiles.ok) return json(safeFiles.error, 400);
        const currentSnapshot = await refreshCurrentSnapshot();
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
        const runIds = [...new Set(url.searchParams.getAll(UrlSearchParam.RunId).filter(Boolean))];
        const unknownRunId = runIds.find((runId) => !changeCheckRunner.describe(runId));
        if (unknownRunId) return json(diagnosticsFailure([runtimeInputDiagnostic(`Unknown Change check run: ${unknownRunId}.`)]), 404);
        const pendingRunIds = new Set(runIds);
        return eventStream(events.connect(() => {
          const initial = [snapshotEvent(stateManager.currentSnapshot(), "Connected to runtime stream.")];
          for (const runId of runIds) {
            const after = streamCursor(url, runId);
            for (const event of changeCheckRunner.listEvents(runId, after)) initial.push(operationEvent(event));
          }
          return initial;
        }, runIds.length === 0 ? {} : {
          closeWhen(event) {
            const operation = event.operation;
            if (operation && pendingRunIds.has(operation.runId) && isTerminalChangeCheckEvent(operation.type)) {
              pendingRunIds.delete(operation.runId);
            }
            return pendingRunIds.size === 0;
          },
        }));
      }
      if (url.pathname === ApiRoute.Events)
        return json({
          ok: true,
          data: listRuntimeEvents(rootDir, currentStore(), { mode: "recent", limit: numberParam(url, UrlSearchParam.Limit, 50) }),
        });
      if (url.pathname === ApiRoute.Observability) {
        const traceId = url.searchParams.get(UrlSearchParam.TraceId)?.trim() || undefined;
        return json({
          ok: true,
          data: currentStore().listObservabilityRecords({
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
          const project = await loadProjectContext(rootDir);
          const report = buildDoctorReport({
            paths: project.paths,
            areas: project.areas,
            changes: project.changes,
            conventions: project.conventions,
            specs: project.specs,
            validators: project.validators,
            producerStatuses: resolveProducerStatuses(rootDir),
            knowledgeInspection: { kind: "available", index: currentStore().readSemanticIndexStatus({ indexId: "project" }).index },
          });
          span.setOutput({ status: report.status, checks: report.checks.length });
          return json({
            ok: true,
            data: report,
          });
        });
      }
      if (url.pathname === ApiRoute.Validate && request.method === "POST") {
        return await tracer.span("validation.run", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, () =>
          validateFromRuntime(rootDir, request, stateManager.validationResultCache()),
        );
      }
      if (url.pathname === ApiRoute.Feedback && request.method === "POST") {
        return await tracer.span("feedback.run", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, () =>
          feedbackFromRuntime(rootDir, request, stateManager.validationResultCache()),
        );
      }
      if (url.pathname === ApiRoute.HookFeedback && request.method === "POST") {
        return await tracer.span("feedback.hook", { kind: SpanKind.TASK, attributes: { source: "runtime" } }, async () =>
          json({ ok: true, data: await hookFeedbackFromRuntime(rootDir, request) }),
        );
      }
      if (url.pathname === ApiRoute.Index && request.method === "POST") {
        const body = await readJsonBody(request);
        try {
          const snapshot = await buildIndexedSnapshot("Manual reindex completed.", { force: body.force === true });
          if (body.response === ProjectIndexResponseMode.SemanticIndex) {
            return json({ ok: true, data: { semanticIndex: snapshot.state.semanticIndex ?? snapshot.semanticIndex ?? null } });
          }
          return json({ ok: true, data: snapshot });
        } catch (error) {
          return json(
            diagnostic(
              diagnosticCodes.semanticIndexBuildFailed,
              `Project Knowledge indexing failed: ${error instanceof Error ? error.message : String(error)}`,
            ),
            500,
          );
        }
      }
      if (url.pathname === ApiRoute.Settings) {
        if (request.method === "GET") return json({ ok: true, data: readProjectSettings(rootDir) });
        const result = writeProjectSettings(rootDir, await readJsonBody(request));
        if (!result.ok) return json(diagnosticsFailure(result.diagnostics), 400);
        paths = createPaths(rootDir);
        stateManager.replaceValidationResultCache(createValidationResultCache(paths));
        await knowledgeQueryRuntime.reset();
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

  return routeRequest;
}

function isTerminalChangeCheckEvent(type: ChangeCheckRunEventType): boolean {
  return type === ChangeCheckRunEventType.Passed || type === ChangeCheckRunEventType.Failed || type === ChangeCheckRunEventType.Cancelled;
}

function streamCursor(url: URL, _runId: string): number {
  const value = Number(url.searchParams.get(UrlSearchParam.After) ?? "0");
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function semanticIndexReady(index: SemanticIndexSnapshot | undefined): boolean {
  return index?.status === SemanticIndexReadinessStatus.Ready && index.staleChunkCount === 0;
}

function semanticIndexDiagnosticDetails(index: SemanticIndexSnapshot | undefined): string[] {
  if (!index) return ["Project Knowledge: missing"];
  return [
    `Project Knowledge status: ${index.status}`,
    `Stale chunks: ${index.staleChunkCount}`,
    `Provider: ${index.provider.displayName ?? index.provider.id} (${index.provider.modelId})`,
    ...index.diagnostics.map((diagnostic) => `${diagnostic.severity}: ${diagnostic.message}`),
  ];
}
