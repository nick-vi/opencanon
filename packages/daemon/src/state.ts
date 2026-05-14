import { createHash } from "node:crypto";
import path from "node:path";
import {
  relative,
  type CanonEvent,
  type CanonFinding,
  type ContextPaths,
  type DaemonHealth,
  type RepoGraph,
  type ScanAndDiffResult,
} from "@opencanon/core";
import type { Engine, EngineProject } from "@opencanon/engine";

export type DaemonStore = {
  statePath: string;
  project: EngineProject;
  scanAndDiff(files: string[]): ScanAndDiffResult;
  writeSnapshot(input: StoreSnapshotInput): void;
  readState(): StoreState;
  writeEvent(event: CanonEvent): void;
  listEvents(limit?: number): CanonEvent[];
  close(): void;
};

export type StoreSnapshotInput = {
  health: DaemonHealth;
  files: string[];
  graph: RepoGraph;
  findings: CanonFinding[];
};

export type StoreState = {
  files: number;
  findings: number;
  staleFiles: number;
  graphHash?: string;
  lastIndexedAt?: string;
};

export function createDaemonStore(input: { rootDir: string; paths: ContextPaths; engine: Engine; statePath?: string }): DaemonStore {
  const statePath = input.statePath ?? path.join(input.rootDir, ".opencanon", "state.sqlite");
  const project = input.engine.openProject({
    rootDir: input.rootDir,
    statePath,
    settings: {
      docsDir: relative(input.rootDir, input.paths.docsDir),
      decisionsPath: relative(input.rootDir, input.paths.decisionsPath),
      validatorsPath: relative(input.rootDir, input.paths.validatorsPath),
      fixturesDir: relative(input.rootDir, input.paths.fixturesDir),
      impactSurfacesPath: relative(input.rootDir, input.paths.impactSurfacesPath),
      proposedImpactNotesPath: relative(input.rootDir, input.paths.proposedImpactNotesPath),
      baselinePath: relative(input.rootDir, input.paths.baselinePath),
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
  let state: StoreState = { files: 0, findings: 0, staleFiles: 0 };

  return {
    statePath,
    project,
    scanAndDiff(files) {
      const result = project.scanAndDiff({ files });
      state = { ...state, files: result.files.length, staleFiles: result.staleFiles };
      return result;
    },
    writeSnapshot(input) {
      state = {
        files: input.files.length,
        findings: input.findings.length,
        staleFiles: state.staleFiles,
        graphHash: input.graph.graphHash,
        lastIndexedAt: new Date().toISOString(),
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
    close() {
      project.close();
    },
  };
}

function hashSettings(paths: ContextPaths): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        configPath: paths.configPath,
        docsDir: relative(paths.rootDir, paths.docsDir),
        decisionsPath: relative(paths.rootDir, paths.decisionsPath),
        validatorsPath: relative(paths.rootDir, paths.validatorsPath),
        fixturesDir: relative(paths.rootDir, paths.fixturesDir),
        impactSurfacesPath: relative(paths.rootDir, paths.impactSurfacesPath),
        proposedImpactNotesPath: relative(paths.rootDir, paths.proposedImpactNotesPath),
        baselinePath: relative(paths.rootDir, paths.baselinePath),
        projectFilePatterns: paths.projectFilePatterns,
        ignore: paths.ignore,
        entrypoints: paths.entrypoints,
        publicSurfaces: paths.publicSurfaces,
        generated: paths.generated,
        externalTools: paths.externalTools,
        fileDiscovery: paths.fileDiscovery,
        maxFiles: paths.maxFiles,
        maxFileSizeKb: paths.maxFileSizeKb,
      }),
    )
    .digest("hex");
}
