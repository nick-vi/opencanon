import { createHash } from "node:crypto";
import path from "node:path";
import {
  relative,
  type CanonEvent,
  type CanonFinding,
  type ContextPaths,
  type RuntimeHealth,
  type ProductModelProjection,
  type RepoGraph,
  type ScanAndDiffResult,
  type ListSemanticChunksRequest,
  type ListSemanticChunksResult,
  type ReadSemanticIndexStatusRequest,
  type ReadSemanticIndexStatusResult,
  type SearchSemanticIndexRequest,
  type SearchSemanticIndexResult,
  type SemanticIndexSnapshot,
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

export type ProjectStore = {
  statePath: string;
  project: EngineProject;
  scanAndDiff(files: string[]): ScanAndDiffResult;
  writeSnapshot(input: StoreSnapshotInput): void;
  readState(): StoreState;
  writeEvent(event: CanonEvent): void;
  listEvents(limit?: number): CanonEvent[];
  writeObservabilityRecords(records: ObservabilityRecordBatch): void;
  listObservabilityRecords(query?: ObservabilityRecordQuery): ObservabilityRecordResult;
  writeSemanticIndex(request: WriteSemanticIndexRequest): void;
  readSemanticIndexStatus(request?: ReadSemanticIndexStatusRequest): ReadSemanticIndexStatusResult;
  listSemanticChunks(request?: ListSemanticChunksRequest): ListSemanticChunksResult;
  searchSemanticIndex(request: SearchSemanticIndexRequest): SearchSemanticIndexResult;
  close(): void;
};

export type StoreSnapshotInput = {
  health: RuntimeHealth;
  files: string[];
  graph: RepoGraph;
  findings: CanonFinding[];
  productModel: ProductModelProjection;
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

export function openProjectStore(input: { rootDir: string; paths: ContextPaths; statePath?: string }): ProjectStore {
  return createProjectStore({ ...input, engine: loadEngine() });
}

export function createProjectStore(input: { rootDir: string; paths: ContextPaths; engine: Engine; statePath?: string }): ProjectStore {
  const statePath = input.statePath ?? path.join(input.rootDir, ".opencanon", "state.sqlite");
  const project = input.engine.openProject({
    rootDir: input.rootDir,
    statePath,
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
  const persistedProductModel = project.readProductModelProjection();
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
    writeSnapshot(input) {
      project.writeProductModelProjection(input.productModel);
      const semanticIndex = project.readSemanticIndexStatus({ indexId: "project" }).index ?? state.semanticIndex;
      state = {
        files: input.files.length,
        findings: input.findings.length,
        staleFiles: state.staleFiles,
        graphHash: input.graph.graphHash,
        lastIndexedAt: new Date().toISOString(),
        productModel: productModelState(input.productModel),
        ...(semanticIndex ? { semanticIndex } : {}),
      };
    },
    readState() {
      return state;
    },
    writeEvent(event) {
      project.writeEvent(event);
    },
    listEvents(limit = 50) {
      return project.listEvents(limit);
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
