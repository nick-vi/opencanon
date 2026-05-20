import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  BuildRepoGraphRequestSchema,
  BuildRepoGraphResultSchema,
  CanonEventSchema,
  ExtractFactsRequestSchema,
  ExtractFactsResultSchema,
  EngineVersionSchema,
  EngineProjectStatusSchema,
  IndexCodeGraphRequestSchema,
  IndexCodeGraphResultSchema,
  OpenCanonErrorCodeSchema,
  OpenProjectRequestSchema,
  OpenCanonError,
  ScanAndDiffRequestSchema,
  ScanAndDiffResultSchema,
  SearchGraphEdgesRequestSchema,
  SearchGraphEdgesResultSchema,
  SearchReferencesRequestSchema,
  SearchReferencesResultSchema,
  SearchSymbolsRequestSchema,
  SearchSymbolsResultSchema,
  WatcherEventBatchSchema,
  WatcherStartRequestSchema,
  WatcherStartResultSchema,
  createOpenCanonDiagnostic,
  type BuildRepoGraphRequest,
  type BuildRepoGraphResult,
  type CanonEvent,
  type ExtractFactsRequest,
  type ExtractFactsResult,
  type EngineVersion,
  type EngineProjectStatus,
  type IndexCodeGraphRequest,
  type IndexCodeGraphResult,
  type OpenProjectRequest,
  type ScanAndDiffRequest,
  type ScanAndDiffResult,
  type SearchGraphEdgesRequest,
  type SearchGraphEdgesResult,
  type SearchReferencesRequest,
  type SearchReferencesResult,
  type SearchSymbolsRequest,
  type SearchSymbolsResult,
  type WatcherEventBatch,
  type WatcherStartRequest,
  type WatcherStartResult,
} from "@opencanon/core";

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
  indexCodeGraph(request: IndexCodeGraphRequest): IndexCodeGraphResult;
  searchSymbols(request: SearchSymbolsRequest): SearchSymbolsResult;
  searchReferences(request: SearchReferencesRequest): SearchReferencesResult;
  searchGraphEdges(request: SearchGraphEdgesRequest): SearchGraphEdgesResult;
  startWatcher(request: WatcherStartRequest, onBatch: (batch: WatcherEventBatch) => void): WatcherStartResult;
  drainWatcherEvents(): WatcherEventBatch[];
  stopWatcher(): void;
  writeEvent(event: CanonEvent): void;
  listEvents(limit?: number): CanonEvent[];
  close(): void;
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
  indexCodeGraphJson(request: string): string;
  searchSymbolsJson(request: string): string;
  searchReferencesJson(request: string): string;
  searchGraphEdgesJson(request: string): string;
  startWatcherJson(request: string, callback: (error: unknown, batchJson?: string) => void): string;
  drainWatcherEventsJson(): string;
  stopWatcher(): void;
  writeEventJson(request: string): void;
  listEventsJson(request: string): string;
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
        action: "Build or install the bundled OpenCanon runtime before starting the daemon.",
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
    indexCodeGraph: (request) =>
      IndexCodeGraphResultSchema.parse(parseJson(callEngine(() => project.indexCodeGraphJson(JSON.stringify(IndexCodeGraphRequestSchema.parse(request)))))),
    searchSymbols: (request) =>
      SearchSymbolsResultSchema.parse(parseJson(callEngine(() => project.searchSymbolsJson(JSON.stringify(SearchSymbolsRequestSchema.parse(request)))))),
    searchReferences: (request) =>
      SearchReferencesResultSchema.parse(parseJson(callEngine(() => project.searchReferencesJson(JSON.stringify(SearchReferencesRequestSchema.parse(request)))))),
    searchGraphEdges: (request) =>
      SearchGraphEdgesResultSchema.parse(parseJson(callEngine(() => project.searchGraphEdgesJson(JSON.stringify(SearchGraphEdgesRequestSchema.parse(request)))))),
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
    listEvents: (limit = 50) => (parseJson(callEngine(() => project.listEventsJson(JSON.stringify({ limit })))) as unknown[]).map((event) => CanonEventSchema.parse(event)),
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
      action: "Rebuild the engine with bun run build:engine.",
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
    "searchSymbolsJson",
    "searchReferencesJson",
    "searchGraphEdgesJson",
    "startWatcherJson",
    "drainWatcherEventsJson",
    "stopWatcher",
    "writeEventJson",
    "listEventsJson",
    "close",
  ].filter((key) => typeof project[key as keyof EngineProjectJsonBinding] !== "function");
  if (missing.length === 0) return;
  throw new OpenCanonError([
    createOpenCanonDiagnostic({
      code: EngineDiagnosticCode.InvalidPayload,
      message: "OpenCanon engine project handle exports are invalid.",
      details: [`Missing engine project exports: ${missing.join(", ")}.`],
      action: "Rebuild the engine with bun run build:engine.",
    }),
  ]);
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
}
