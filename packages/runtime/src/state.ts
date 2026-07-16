import { createHash } from "node:crypto";
import path from "node:path";
import {
  relative,
  type CanonEvent,
  type CanonFinding,
  type ChangeCheckRun,
  type ChangeCheckRunAdmissionResult,
  type ChangeCheckRunEvent,
  type ChangeCheckRunEventDraft,
  type ChangeCheckRunEventQuery,
  type ChangeCheckRunPruneRequest,
  type ChangeCheckRunPruneResult,
  type ChangeCheckRunQuery,
  type CanonEventQuery,
  type ContextPaths,
  type RuntimeHealth,
  type ProductModelProjection,
  type ProjectPublicationState,
  type PublishProjectStateResult,
  type PersistedProjectProtocolEventDraft,
  type ProjectProtocolEvent,
  type ProtocolEventWindow,
  type RepoGraph,
  type ScanAndDiffResult,
  type ListSemanticChunksRequest,
  type ListSemanticChunksResult,
  type ReadSemanticIndexStatusRequest,
  type ReadSemanticIndexStatusResult,
  type SearchSemanticIndexRequest,
  type SearchSemanticIndexResult,
  type SemanticIndexSnapshot,
  type WriteSemanticIndexDeltaRequest,
  type WriteSemanticIndexRequest,
} from "@opencanon/core";
import {
  loadEngine,
  type Engine,
  type EngineProject,
  type ObservabilityRecordBatch,
  type ObservabilityRecordQuery,
  type ObservabilityRecordResult,
} from "@opencanon/engine";
import { projectRuntimeStatePath, StableRuntimeNamespace } from "./service-namespace.ts";

export type ProjectStore = {
  statePath: string;
  project: EngineProject;
  scanAndDiff(files: string[]): ScanAndDiffResult;
  publication(): ProjectPublicationState;
  publishProjectState(input: StorePublicationInput): PublishProjectStateResult;
  readState(): StoreState;
  writeEvent(event: CanonEvent): void;
  listEvents(query: CanonEventQuery): CanonEvent[];
  appendProtocolEvent(event: PersistedProjectProtocolEventDraft): ProjectProtocolEvent;
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
  writeSemanticIndex(request: WriteSemanticIndexRequest): void;
  writeSemanticIndexDelta(request: WriteSemanticIndexDeltaRequest): void;
  readSemanticIndexStatus(request?: ReadSemanticIndexStatusRequest): ReadSemanticIndexStatusResult;
  listSemanticChunks(request?: ListSemanticChunksRequest): ListSemanticChunksResult;
  searchSemanticIndex(request: SearchSemanticIndexRequest): SearchSemanticIndexResult;
  close(): void;
};

export type ProjectAnalysisStore = Pick<
  ProjectStore,
  "statePath" | "project" | "scanAndDiff" | "listEvents" | "readSemanticIndexStatus" | "close"
>;

export type StoreSnapshotInput = {
  health: RuntimeHealth;
  files: string[];
  graph: RepoGraph;
  findings: CanonFinding[];
  staleFiles: number;
  productModel: ProductModelProjection;
};

export type StorePublicationInput = {
  revision: number;
  protocolEvent: PersistedProjectProtocolEventDraft;
  codeGraphGeneration?: string;
  snapshot?: StoreSnapshotInput;
  canonEvent?: CanonEvent;
};

export type StoreState = {
  files: number;
  findings: number;
  staleFiles: number;
  graphHash?: string;
  lastIndexedAt?: string;
  productModel?: ProductModelProjection["counts"] & {
    graphHash: string;
    definitionsHash: string;
    indexedAt: string;
  };
  semanticIndex?: SemanticIndexSnapshot;
};

const ProtocolEventRetentionCount = 10_000;
const ProtocolEventRetentionMs = 7 * 24 * 60 * 60 * 1000;

export function openProjectStore(input: { rootDir: string; paths: ContextPaths; statePath?: string }): ProjectStore {
  return createProjectStore({ ...input, engine: loadEngine() });
}

export function createProjectStore(input: { rootDir: string; paths: ContextPaths; engine: Engine; statePath?: string }): ProjectStore {
  const statePath = input.statePath ?? projectRuntimeStatePath(input.rootDir, StableRuntimeNamespace);
  const project = openStoreProject({
    ...input,
    statePath,
    codeGraphStatePath: statePath,
  });
  const persistedProductModel = project.readProductModelProjection();
  let publication = project.readProjectPublication();
  const persistedSemanticIndex = project.readSemanticIndexStatus({ indexId: "project" }).index;
  let state: StoreState = {
    files: 0,
    findings: 0,
    staleFiles: 0,
    ...(persistedProductModel ? { productModel: productModelState(persistedProductModel) } : {}),
    ...(persistedSemanticIndex ? { semanticIndex: persistedSemanticIndex } : {}),
  };

  return {
    statePath,
    project,
    scanAndDiff(files) {
      const result = project.scanAndDiff({ files });
      state = { ...state, files: result.files.length, staleFiles: result.staleFiles };
      return result;
    },
    publication: () => publication,
    publishProjectState(input) {
      if (Boolean(input.codeGraphGeneration) !== Boolean(input.snapshot)) {
        throw new Error("A Project State publication must include both a code graph generation and snapshot, or neither.");
      }
      const semanticIndex = input.snapshot
        ? project.readSemanticIndexStatus({ indexId: "project" }).index ?? state.semanticIndex
        : undefined;
      const result = project.publishProjectState({
        revision: input.revision,
        ...(input.codeGraphGeneration ? { codeGraphGeneration: input.codeGraphGeneration } : {}),
        ...(input.snapshot ? { productModel: input.snapshot.productModel } : {}),
        ...(input.canonEvent ? { canonEvent: input.canonEvent } : {}),
        protocolEvent: input.protocolEvent,
        maxProtocolEventCount: ProtocolEventRetentionCount,
        retainProtocolEventsAfter: new Date(Date.now() - ProtocolEventRetentionMs).toISOString(),
      });
      publication = result.publication;
      if (!input.snapshot) return result;
      const snapshot = input.snapshot;
      state = {
        files: snapshot.files.length,
        findings: snapshot.findings.length,
        staleFiles: snapshot.staleFiles,
        graphHash: snapshot.graph.graphHash,
        lastIndexedAt: new Date().toISOString(),
        productModel: productModelState(snapshot.productModel),
        ...(semanticIndex ? { semanticIndex } : {}),
      };
      return result;
    },
    readState() {
      return state;
    },
    writeEvent(event) {
      project.writeEvent(event);
    },
    listEvents(query) {
      return project.listEvents(query);
    },
    appendProtocolEvent(event) {
      return project.appendProtocolEvent({
        event,
        maxCount: ProtocolEventRetentionCount,
        retainAfter: new Date(Date.now() - ProtocolEventRetentionMs).toISOString(),
      });
    },
    listProtocolEvents(input) {
      return project.listProtocolEvents(input);
    },
    writeJob(job) {
      project.writeJob(job);
    },
    readJob(jobId) {
      return project.readJob(jobId);
    },
    listJobs(query) {
      return project.listJobs(query);
    },
    admitJobs(input) {
      return project.admitJobs(input);
    },
    pruneJobs(request) {
      return project.pruneJobs(request);
    },
    appendJobEvent(event) {
      return project.appendJobEvent(event);
    },
    listJobEvents(request) {
      return project.listJobEvents(request);
    },
    writeObservabilityRecords(records) {
      project.writeObservabilityRecords(records);
    },
    listObservabilityRecords(query = {}) {
      return project.listObservabilityRecords(query);
    },
    writeSemanticIndex(request) {
      project.writeSemanticIndex(request);
      state = { ...state, semanticIndex: request.index };
    },
    writeSemanticIndexDelta(request) {
      project.writeSemanticIndexDelta(request);
      state = { ...state, semanticIndex: request.index };
    },
    readSemanticIndexStatus(request = {}) {
      return project.readSemanticIndexStatus(request);
    },
    listSemanticChunks(request = {}) {
      return project.listSemanticChunks(request);
    },
    searchSemanticIndex(request) {
      return project.searchSemanticIndex(request);
    },
    close() {
      project.close();
    },
  };
}

export function createProjectAnalysisStore(input: {
  rootDir: string;
  paths: ContextPaths;
  engine: Engine;
  statePath: string;
  codeGraphStatePath: string;
}): ProjectAnalysisStore {
  const project = openStoreProject(input);
  return {
    statePath: input.statePath,
    project,
    scanAndDiff(files) {
      return project.scanAndDiff({ files });
    },
    listEvents(query) {
      return project.listEvents(query);
    },
    readSemanticIndexStatus(request = {}) {
      return project.readSemanticIndexStatus(request);
    },
    close() {
      project.close();
    },
  };
}

function openStoreProject(input: {
  rootDir: string;
  paths: ContextPaths;
  engine: Engine;
  statePath: string;
  codeGraphStatePath: string;
}): EngineProject {
  return input.engine.openProject({
    rootDir: input.rootDir,
    statePath: input.statePath,
    codeGraphStatePath: input.codeGraphStatePath,
    settings: {
      docsDir: relative(input.rootDir, input.paths.docsDir),
      conventionsPath: relative(input.rootDir, input.paths.conventionsPath),
      areasPath: relative(input.rootDir, input.paths.areasPath),
      specsPath: relative(input.rootDir, input.paths.specsPath),
      changesPath: relative(input.rootDir, input.paths.changesPath),
      fixturesDir: relative(input.rootDir, input.paths.fixturesDir),
      impactSurfacesPath: relative(input.rootDir, input.paths.impactSurfacesPath),
      proposedImpactNotesPath: relative(input.rootDir, input.paths.proposedImpactNotesPath),
      baselinePath: relative(input.rootDir, input.paths.baselinePath),
      commitApprovalsPath: relative(input.rootDir, input.paths.commitApprovalsPath),
      commitApprovalsPersistent: input.paths.commitApprovalsPersistent,
      projectFilePatterns: input.paths.projectFilePatterns,
      ignore: input.paths.ignore,
      entrypoints: input.paths.entrypoints,
      publicSurfaces: input.paths.publicSurfaces,
      generated: input.paths.generated,
      externalTools: input.paths.externalTools,
      maxFiles: input.paths.maxFiles,
      maxFileSizeKb: input.paths.maxFileSizeKb,
      fileDiscovery: input.paths.fileDiscovery,
      configHash: hashSettings(input.paths),
    },
  });
}

function productModelState(productModel: ProductModelProjection): NonNullable<StoreState["productModel"]> {
  return {
    ...productModel.counts,
    graphHash: productModel.graphHash,
    definitionsHash: productModel.definitionsHash,
    indexedAt: productModel.indexedAt,
  };
}

function hashSettings(paths: ContextPaths): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        configPath: paths.configPath,
        docsDir: relative(paths.rootDir, paths.docsDir),
        conventionsPath: relative(paths.rootDir, paths.conventionsPath),
        areasPath: relative(paths.rootDir, paths.areasPath),
        specsPath: relative(paths.rootDir, paths.specsPath),
        changesPath: relative(paths.rootDir, paths.changesPath),
        fixturesDir: relative(paths.rootDir, paths.fixturesDir),
        impactSurfacesPath: relative(paths.rootDir, paths.impactSurfacesPath),
        proposedImpactNotesPath: relative(paths.rootDir, paths.proposedImpactNotesPath),
        baselinePath: relative(paths.rootDir, paths.baselinePath),
        commitApprovalsPath: relative(paths.rootDir, paths.commitApprovalsPath),
        commitApprovalsPersistent: paths.commitApprovalsPersistent,
        projectFilePatterns: paths.projectFilePatterns,
        ignore: paths.ignore,
        entrypoints: paths.entrypoints,
        publicSurfaces: paths.publicSurfaces,
        generated: paths.generated,
        externalTools: paths.externalTools,
        fileDiscovery: paths.fileDiscovery,
        maxFiles: paths.maxFiles,
        maxFileSizeKb: paths.maxFileSizeKb,
        semanticEmbedding: paths.semanticEmbedding,
      }),
    )
    .digest("hex");
}
