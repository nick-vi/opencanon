import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuildRepoGraphRequestSchema,
  BuildRepoGraphResultSchema,
  CanonEventSchema,
  ChangeCheckRunEventSchema,
  ChangeCheckRunEventDraftSchema,
  ChangeCheckRunAdmissionResultSchema,
  ChangeCheckRunPruneResultSchema,
  ChangeCheckRunSchema,
  ExtractFactsRequestSchema,
  ExtractFactsResultSchema,
  EngineVersionSchema,
  EngineProjectStatusSchema,
  EmbedSemanticTextsRequestSchema,
  EmbedSemanticTextsResultSchema,
  GenerateTextRequestSchema,
  GenerateTextResultSchema,
  IndexCodeGraphRequestSchema,
  IndexCodeGraphResultSchema,
  ListSemanticChunksRequestSchema,
  ListSemanticChunksResultSchema,
  OpenCanonErrorCodeSchema,
  PersistedProjectProtocolEventDraftSchema,
  ProjectProtocolEventSchema,
  ProtocolEventWindowSchema,
  OpenProjectRequestSchema,
  OpenCanonError,
  ReadProductModelProjectionResultSchema,
  ReadSemanticIndexStatusRequestSchema,
  ReadSemanticIndexStatusResultSchema,
  ScanAndDiffRequestSchema,
  ScanAndDiffResultSchema,
  SearchGraphEdgesRequestSchema,
  SearchGraphEdgesResultSchema,
  SearchReferencesRequestSchema,
  SearchReferencesResultSchema,
  SearchSemanticIndexRequestSchema,
  SearchSemanticIndexResultSchema,
  SearchSymbolsRequestSchema,
  SearchSymbolsResultSchema,
  WatcherEventBatchSchema,
  WatcherStartRequestSchema,
  WatcherStartResultSchema,
  WriteProductModelProjectionRequestSchema,
  WriteSemanticIndexDeltaRequestSchema,
  WriteSemanticIndexRequestSchema,
  createOpenCanonDiagnostic,
  type BuildRepoGraphRequest,
  type BuildRepoGraphResult,
  type CanonEvent,
  type CanonEventQuery,
  type ChangeCheckRun,
  type ChangeCheckRunAdmissionResult,
  type ChangeCheckRunEvent,
  type ChangeCheckRunEventDraft,
  type ChangeCheckRunEventQuery,
  type ChangeCheckRunPruneRequest,
  type ChangeCheckRunPruneResult,
  type ChangeCheckRunQuery,
  type EmbedSemanticTextsRequest,
  type EmbedSemanticTextsResult,
  type GenerateTextRequest,
  type GenerateTextResult,
  type ExtractFactsRequest,
  type ExtractFactsResult,
  type EngineVersion,
  type EngineProjectStatus,
  type IndexCodeGraphRequest,
  type IndexCodeGraphResult,
  type ListSemanticChunksRequest,
  type ListSemanticChunksResult,
  type OpenProjectRequest,
  type PersistedProjectProtocolEventDraft,
  type ProjectProtocolEvent,
  type ProtocolEventWindow,
  type ProductModelProjection,
  type ReadSemanticIndexStatusRequest,
  type ReadSemanticIndexStatusResult,
  type ScanAndDiffRequest,
  type ScanAndDiffResult,
  type SearchGraphEdgesRequest,
  type SearchGraphEdgesResult,
  type SearchReferencesRequest,
  type SearchReferencesResult,
  type SearchSemanticIndexRequest,
  type SearchSemanticIndexResult,
  type SearchSymbolsRequest,
  type SearchSymbolsResult,
  type WatcherEventBatch,
  type WatcherStartRequest,
  type WatcherStartResult,
  type WriteSemanticIndexDeltaRequest,
  type WriteSemanticIndexRequest,
} from "@opencanon/core";
import type { SpanRecord, TraceEventRecord, TraceRecord } from "@opencanon/observability";

const require = createRequire(import.meta.url);
const packageSourceDir = fileURLToPath(new URL(".", import.meta.url));
const EngineDiagnosticCode = {
  InvalidPayload: "invalid-engine-payload",
} as const;

export type Engine = {
  version(): EngineVersion;
  openProject(request: OpenProjectRequest): EngineProject;
};

export type ProjectExtractFactsRequest = ExtractFactsRequest;
export type ProjectBuildRepoGraphRequest = BuildRepoGraphRequest;

export type EngineProject = {
  status(): EngineProjectStatus;
  scanAndDiff(request: ScanAndDiffRequest): ScanAndDiffResult;
  extractFacts(request: ProjectExtractFactsRequest): ExtractFactsResult;
  buildRepoGraph(request: ProjectBuildRepoGraphRequest): BuildRepoGraphResult;
  indexCodeGraph(request: IndexCodeGraphRequest): Promise<IndexCodeGraphResult>;
  activateCodeGraph(generation: string): void;
  searchSymbols(request: SearchSymbolsRequest): SearchSymbolsResult;
  searchReferences(request: SearchReferencesRequest): SearchReferencesResult;
  searchGraphEdges(request: SearchGraphEdgesRequest): SearchGraphEdgesResult;
  writeProductModelProjection(projection: ProductModelProjection): void;
  readProductModelProjection(): ProductModelProjection | null;
  writeSemanticIndex(request: WriteSemanticIndexRequest): void;
  writeSemanticIndexDelta(request: WriteSemanticIndexDeltaRequest): void;
  readSemanticIndexStatus(request?: ReadSemanticIndexStatusRequest): ReadSemanticIndexStatusResult;
  listSemanticChunks(request?: ListSemanticChunksRequest): ListSemanticChunksResult;
  searchSemanticIndex(request: SearchSemanticIndexRequest): SearchSemanticIndexResult;
  embedSemanticTexts(request: EmbedSemanticTextsRequest): EmbedSemanticTextsResult;
  generateText(request: GenerateTextRequest): GenerateTextResult;
  startWatcher(request: WatcherStartRequest, onBatch: (batch: WatcherEventBatch) => void): WatcherStartResult;
  drainWatcherEvents(): WatcherEventBatch[];
  stopWatcher(): void;
  writeEvent(event: CanonEvent): void;
  listEvents(query: CanonEventQuery): CanonEvent[];
  appendProtocolEvent(input: { event: PersistedProjectProtocolEventDraft; maxCount: number; retainAfter: string }): ProjectProtocolEvent;
  listProtocolEvents(input: { afterSequence: number; limit: number; operationId?: string }): ProtocolEventWindow;
  writeJob(job: ChangeCheckRun): void;
  readJob(jobId: string): ChangeCheckRun | null;
  listJobs(query: ChangeCheckRunQuery): ChangeCheckRun[];
  admitJobs(input: { runs: ChangeCheckRun[]; events: ChangeCheckRunEvent[]; capacity: number }): ChangeCheckRunAdmissionResult;
  pruneJobs(request: ChangeCheckRunPruneRequest): ChangeCheckRunPruneResult;
  appendJobEvent(event: ChangeCheckRunEventDraft): ChangeCheckRunEvent;
  listJobEvents(request: ChangeCheckRunEventQuery): ChangeCheckRunEvent[];
  writeObservabilityRecords(records: ObservabilityRecordBatch): void;
  listObservabilityRecords(query?: ObservabilityRecordQuery): ObservabilityRecordResult;
  close(): void;
};

export type ObservabilityRecordBatch = {
  traces?: readonly TraceRecord[] | undefined;
  spans?: readonly SpanRecord[] | undefined;
  events?: readonly TraceEventRecord[] | undefined;
};

export type ObservabilityRecordQuery = {
  limit?: number | undefined;
  traceId?: string | undefined;
};

export type ObservabilityRecordResult = {
  traces: TraceRecord[];
  spans: SpanRecord[];
  events: TraceEventRecord[];
};

type EngineJsonBinding = {
  versionJson(): string;
  openProjectJson(request: string): EngineProjectJsonBinding;
};

type EngineProjectJsonBinding = {
  statusJson(): string;
  scanAndDiffJson(request: string): string;
  extractFactsJson(request: string): string;
  buildRepoGraphJson(request: string): string;
  indexCodeGraphJson(request: string): string | Promise<string>;
  activateCodeGraphJson(request: string): void;
  searchSymbolsJson(request: string): string;
  searchReferencesJson(request: string): string;
  searchGraphEdgesJson(request: string): string;
  writeProductModelProjectionJson(request: string): void;
  readProductModelProjectionJson(): string;
  writeSemanticIndexJson(request: string): void;
  writeSemanticIndexDeltaJson(request: string): void;
  readSemanticIndexStatusJson(request: string): string;
  listSemanticChunksJson(request: string): string;
  searchSemanticIndexJson(request: string): string;
  embedSemanticTextsJson(request: string): string;
  generateTextJson(request: string): string;
  startWatcherJson(request: string, callback: (error: unknown, batchJson?: string) => void): string;
  drainWatcherEventsJson(): string;
  stopWatcher(): void;
  writeEventJson(request: string): void;
  listEventsJson(request: string): string;
  appendProtocolEventJson(request: string): string;
  listProtocolEventsJson(request: string): string;
  writeJobJson(request: string): void;
  readJobJson(request: string): string;
  listJobsJson(request: string): string;
  admitJobsJson(request: string): string;
  pruneJobsJson(request: string): string;
  appendJobEventJson(request: string): string;
  listJobEventsJson(request: string): string;
  writeObservabilityRecordsJson(request: string): void;
  listObservabilityRecordsJson(request: string): string;
  close(): void;
};

export type EnginePlatform = NodeJS.Platform;
export type EngineArch = NodeJS.Architecture;

export function engineBindingName(moduleName = "opencanon", platform: EnginePlatform = process.platform, arch: EngineArch = process.arch): string {
  const target = `${platform}-${arch}`;
  const suffixes: Record<string, string> = {
    "darwin-arm64": "darwin-arm64",
    "darwin-x64": "darwin-x64",
    "linux-arm64": "linux-arm64-gnu",
    "linux-x64": "linux-x64-gnu",
    "win32-x64": "win32-x64-msvc",
  };
  const suffix = suffixes[target];
  if (!suffix) {
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: "engine-binary-missing",
        message: `Unsupported engine platform: ${target}.`,
        details: [`Supported platforms: ${Object.keys(suffixes).join(", ")}.`],
      }),
    ]);
  }
  return `${moduleName}.${suffix}.node`;
}

export function engineBindingPath(moduleName = "opencanon"): string {
  const candidates = engineBindingPathCandidates(moduleName);
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function engineBindingPathCandidates(moduleName = "opencanon"): string[] {
  const bindingName = engineBindingName(moduleName);
  const target = `${process.platform}-${process.arch}`;
  return [
    path.join(packageSourceDir, "..", "binaries", bindingName),
    path.join(packageSourceDir, "engine", target, bindingName),
    path.join(packageSourceDir, "engine", target, `${moduleName}.node`),
  ];
}

export function loadEngine(moduleName = "opencanon"): Engine {
  const bindingPath = engineBindingPath(moduleName);
  if (!existsSync(bindingPath)) {
    const candidates = engineBindingPathCandidates(moduleName);
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: "engine-binary-missing",
        message: "OpenCanon engine binary is required.",
        details: candidates.map((candidate) => `Expected ${candidate}.`),
        action: "Build or install the bundled OpenCanon runtime before starting the project runtime.",
      }),
    ]);
  }

  const binding = require(bindingPath) as Partial<EngineJsonBinding>;
  const engine = createEngine(binding);
  validateEngineVersion(engine.version());
  return engine;
}

export function validateEngineVersion(value: unknown): EngineVersion {
  return EngineVersionSchema.parse(value);
}

export function createEngine(binding: Partial<EngineJsonBinding>): Engine {
  assertEngineJsonBinding(binding);
  return {
    version: () => EngineVersionSchema.parse(parseJson(binding.versionJson())),
    openProject: (request) => {
      const project = callEngine(() => binding.openProjectJson(JSON.stringify(OpenProjectRequestSchema.parse(request))));
      return createEngineProject(project);
    },
  };
}

function createEngineProject(project: EngineProjectJsonBinding): EngineProject {
  assertEngineProjectJsonBinding(project);
  return {
    status: () => EngineProjectStatusSchema.parse(parseJson(callEngine(() => project.statusJson()))),
    scanAndDiff: (request) => ScanAndDiffResultSchema.parse(parseJson(callEngine(() => project.scanAndDiffJson(JSON.stringify(ScanAndDiffRequestSchema.parse(request)))))),
    extractFacts: (request) => ExtractFactsResultSchema.parse(parseJson(callEngine(() => project.extractFactsJson(JSON.stringify(ExtractFactsRequestSchema.parse(request)))))),
    buildRepoGraph: (request) =>
      BuildRepoGraphResultSchema.parse(parseJson(callEngine(() => project.buildRepoGraphJson(JSON.stringify(BuildRepoGraphRequestSchema.parse(request)))))),
    indexCodeGraph: async (request) =>
      IndexCodeGraphResultSchema.parse(parseJson(await callEngineAsync(() => project.indexCodeGraphJson(JSON.stringify(IndexCodeGraphRequestSchema.parse({ ...request, generation: randomUUID() })))))),
    activateCodeGraph: (generation) => callEngine(() => project.activateCodeGraphJson(JSON.stringify({ generation }))),
    searchSymbols: (request) =>
      SearchSymbolsResultSchema.parse(parseJson(callEngine(() => project.searchSymbolsJson(JSON.stringify(SearchSymbolsRequestSchema.parse(request)))))),
    searchReferences: (request) =>
      SearchReferencesResultSchema.parse(parseJson(callEngine(() => project.searchReferencesJson(JSON.stringify(SearchReferencesRequestSchema.parse(request)))))),
    searchGraphEdges: (request) =>
      SearchGraphEdgesResultSchema.parse(parseJson(callEngine(() => project.searchGraphEdgesJson(JSON.stringify(SearchGraphEdgesRequestSchema.parse(request)))))),
    writeProductModelProjection: (projection) =>
      callEngine(() => project.writeProductModelProjectionJson(JSON.stringify(WriteProductModelProjectionRequestSchema.parse({ projection })))),
    readProductModelProjection: () => {
      const parsed = ReadProductModelProjectionResultSchema.safeParse(parseJson(callEngine(() => project.readProductModelProjectionJson())));
      return parsed.success ? parsed.data.projection : null;
    },
    writeSemanticIndex: (request) =>
      callEngine(() => project.writeSemanticIndexJson(JSON.stringify(WriteSemanticIndexRequestSchema.parse(request)))),
    writeSemanticIndexDelta: (request) =>
      callEngine(() => project.writeSemanticIndexDeltaJson(JSON.stringify(WriteSemanticIndexDeltaRequestSchema.parse(request)))),
    readSemanticIndexStatus: (request = {}) =>
      ReadSemanticIndexStatusResultSchema.parse(
        parseJson(callEngine(() => project.readSemanticIndexStatusJson(JSON.stringify(ReadSemanticIndexStatusRequestSchema.parse(request))))),
      ),
    listSemanticChunks: (request = {}) =>
      ListSemanticChunksResultSchema.parse(
        parseJson(callEngine(() => project.listSemanticChunksJson(JSON.stringify(ListSemanticChunksRequestSchema.parse(request))))),
      ),
    searchSemanticIndex: (request) =>
      SearchSemanticIndexResultSchema.parse(
        parseJson(callEngine(() => project.searchSemanticIndexJson(JSON.stringify(SearchSemanticIndexRequestSchema.parse(request))))),
      ),
    embedSemanticTexts: (request) =>
      EmbedSemanticTextsResultSchema.parse(
        parseJson(callEngine(() => project.embedSemanticTextsJson(JSON.stringify(EmbedSemanticTextsRequestSchema.parse(request))))),
      ),
    generateText: (request) =>
      GenerateTextResultSchema.parse(
        parseJson(callEngine(() => project.generateTextJson(JSON.stringify(GenerateTextRequestSchema.parse(request))))),
      ),
    startWatcher: (request, onBatch) =>
      WatcherStartResultSchema.parse(
        parseJson(
          callEngine(() =>
            project.startWatcherJson(JSON.stringify(WatcherStartRequestSchema.parse(request)), (error: unknown, batchJson?: string) => {
              if (error || !batchJson) return;
              try {
                onBatch(WatcherEventBatchSchema.parse(parseJson(batchJson)));
              } catch {
                return;
              }
            }),
          ),
        ),
      ),
    drainWatcherEvents: () =>
      (parseJson(callEngine(() => project.drainWatcherEventsJson())) as unknown[]).map((batch) => WatcherEventBatchSchema.parse(batch)),
    stopWatcher: () => callEngine(() => project.stopWatcher()),
    writeEvent: (event) => callEngine(() => project.writeEventJson(JSON.stringify({ event: CanonEventSchema.parse(event) }))),
    listEvents: (query) => (parseJson(callEngine(() => project.listEventsJson(JSON.stringify(query)))) as unknown[]).map((event) => CanonEventSchema.parse(event)),
    appendProtocolEvent: (input) =>
      ProjectProtocolEventSchema.parse(
        parseJson(
          callEngine(() =>
            project.appendProtocolEventJson(
              JSON.stringify({
                event: PersistedProjectProtocolEventDraftSchema.parse(input.event),
                maxCount: input.maxCount,
                retainAfter: input.retainAfter,
              }),
            ),
          ),
        ),
      ),
    listProtocolEvents: (input) =>
      ProtocolEventWindowSchema.parse(
        parseJson(callEngine(() => project.listProtocolEventsJson(JSON.stringify(input)))),
      ),
    writeJob: (job) => callEngine(() => project.writeJobJson(JSON.stringify({ job: ChangeCheckRunSchema.parse(job) }))),
    readJob: (jobId) => {
      const value = parseJson(callEngine(() => project.readJobJson(JSON.stringify({ jobId })))) as { job?: unknown };
      return value.job ? ChangeCheckRunSchema.parse(value.job) : null;
    },
    listJobs: (query) => (parseJson(callEngine(() => project.listJobsJson(JSON.stringify(query)))) as unknown[]).map((job) => ChangeCheckRunSchema.parse(job)),
    admitJobs: ({ runs, events, capacity }) =>
      ChangeCheckRunAdmissionResultSchema.parse(
        parseJson(
          callEngine(() =>
            project.admitJobsJson(
              JSON.stringify({
                jobs: runs.map((run) => ChangeCheckRunSchema.parse(run)),
                events: events.map((event) => ChangeCheckRunEventSchema.parse(event)),
                capacity,
              }),
            ),
          ),
        ),
      ),
    pruneJobs: (request) =>
      ChangeCheckRunPruneResultSchema.parse(
        parseJson(callEngine(() => project.pruneJobsJson(JSON.stringify(request)))),
      ),
    appendJobEvent: (event) =>
      ChangeCheckRunEventSchema.parse(
        parseJson(
          callEngine(() => project.appendJobEventJson(JSON.stringify({ event: ChangeCheckRunEventDraftSchema.parse(event) }))),
        ),
      ),
    listJobEvents: (request) => (parseJson(callEngine(() => project.listJobEventsJson(JSON.stringify(request)))) as unknown[]).map((event) => ChangeCheckRunEventSchema.parse(event)),
    writeObservabilityRecords: (records) => callEngine(() => project.writeObservabilityRecordsJson(JSON.stringify(records))),
    listObservabilityRecords: (query = {}) => parseObservabilityRecordResult(parseJson(callEngine(() => project.listObservabilityRecordsJson(JSON.stringify(query))))),
    close: () => callEngine(() => project.close()),
  };
}

function assertEngineJsonBinding(binding: Partial<EngineJsonBinding>): asserts binding is EngineJsonBinding {
  const missing = ["versionJson", "openProjectJson"].filter(
    (key) => typeof binding[key as keyof EngineJsonBinding] !== "function",
  );
  if (missing.length === 0) return;
  throw new OpenCanonError([
    createOpenCanonDiagnostic({
      code: EngineDiagnosticCode.InvalidPayload,
      message: "OpenCanon engine exports are invalid.",
      details: [`Missing engine JSON exports: ${missing.join(", ")}.`],
      action: "Rebuild the engine with npm run build:engine.",
    }),
  ]);
}

function assertEngineProjectJsonBinding(project: Partial<EngineProjectJsonBinding>): asserts project is EngineProjectJsonBinding {
  const missing = [
    "statusJson",
    "scanAndDiffJson",
    "extractFactsJson",
    "buildRepoGraphJson",
    "indexCodeGraphJson",
    "activateCodeGraphJson",
    "searchSymbolsJson",
    "searchReferencesJson",
    "searchGraphEdgesJson",
    "writeProductModelProjectionJson",
    "readProductModelProjectionJson",
    "writeSemanticIndexJson",
    "writeSemanticIndexDeltaJson",
    "readSemanticIndexStatusJson",
    "listSemanticChunksJson",
    "searchSemanticIndexJson",
    "embedSemanticTextsJson",
    "generateTextJson",
    "startWatcherJson",
    "drainWatcherEventsJson",
    "stopWatcher",
    "writeEventJson",
    "listEventsJson",
    "appendProtocolEventJson",
    "listProtocolEventsJson",
    "writeJobJson",
    "readJobJson",
    "listJobsJson",
    "admitJobsJson",
    "pruneJobsJson",
    "appendJobEventJson",
    "listJobEventsJson",
    "writeObservabilityRecordsJson",
    "listObservabilityRecordsJson",
    "close",
  ].filter((key) => typeof project[key as keyof EngineProjectJsonBinding] !== "function");
  if (missing.length === 0) return;
  throw new OpenCanonError([
    createOpenCanonDiagnostic({
      code: EngineDiagnosticCode.InvalidPayload,
      message: "OpenCanon engine project handle exports are invalid.",
      details: [`Missing engine project exports: ${missing.join(", ")}.`],
      action: "Rebuild the engine with npm run build:engine.",
    }),
  ]);
}

function parseObservabilityRecordResult(value: unknown): ObservabilityRecordResult {
  if (typeof value !== "object" || value === null) {
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: EngineDiagnosticCode.InvalidPayload,
        message: "OpenCanon engine returned invalid observability records.",
      }),
    ]);
  }
  const record = value as Record<string, unknown>;
  return {
    traces: arrayOrEmpty(record.traces) as TraceRecord[],
    spans: arrayOrEmpty(record.spans) as SpanRecord[],
    events: arrayOrEmpty(record.events) as TraceEventRecord[],
  };
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: EngineDiagnosticCode.InvalidPayload,
        message: "OpenCanon engine returned invalid JSON.",
        details: [error instanceof Error ? error.message : String(error)],
      }),
    ]);
  }
}

function callEngine<T>(callback: () => T): T {
  try {
    return callback();
  } catch (error) {
    throwEngineError(error);
  }
}

async function callEngineAsync<T>(callback: () => T | Promise<T>): Promise<T> {
  try {
    return await callback();
  } catch (error) {
    throwEngineError(error);
  }
}

function throwEngineError(error: unknown): never {
  if (error instanceof OpenCanonError) throw error;
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/^\[([a-z0-9-]+)\]\s*(.*)$/);
  if (match) {
    const code = OpenCanonErrorCodeSchema.safeParse(match[1]);
    if (code.success) {
      throw new OpenCanonError([
        createOpenCanonDiagnostic({
          code: code.data,
          message: match[2] || message,
        }),
      ]);
    }
  }
  throw error;
}
