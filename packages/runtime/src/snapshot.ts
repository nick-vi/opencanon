import path from "node:path";
import { createHash } from "node:crypto";
import {
  CanonEventQueryMode,
  createValidationContext,
  buildDefinitionGraph,
  FixSafety,
  BatchProducerPolicy,
  loadProjectContext,
  resolveDocsReferences,
  runValidation,
  type CanonFinding,
  type CanonEvent,
  type Area,
  type Change,
  type Convention,
  type Spec,
  type DefinitionGraph,
  type DefinitionGraphFileCoverage,
  type DefinitionTarget,
  type RuntimeHealth,
  type RuntimeState,
  type DocSnippet,
  type ImpactSurface,
  type RuntimeProjectSummary,
  summarizeRuntimeHealth,
  type ChangeTaskState,
  type FileFacts,
  type RepoGraph,
  type SemanticEmbeddingConfig,
  type SemanticIndexSnapshot,
  type ValidationResultCache,
  type Validator,
  type ValidatorOutcome,
  type ProducerPolicy,
  type ProducerSnapshot,
  type ProductModelProjection,
} from "@opencanon/core";
import type { Engine } from "@opencanon/engine";
import type { ProjectAnalysisStore, ProjectStore } from "./state.ts";
import { cachedSemanticIndexSnapshot, cachedStartupSemanticIndexSnapshot } from "./semantic-index-snapshot.ts";
import { activeTaskLeaseSummaries, listGlobalCanonEvents, mergeCanonEvents } from "./worktree-coordination.ts";
import { listCompleteChangeHistories } from "./server-canon-events.ts";
import {
  buildProductModelProjection,
  buildSnapshotFileCoverage,
  conventionsByValidator,
  docsByConvention,
  snapshotArea,
  snapshotChange,
  snapshotConvention,
  snapshotImpactSurfaces,
  snapshotSpec,
  unique,
} from "./snapshot-projection.ts";
import { findingSnapshotId } from "./snapshot-related.ts";
import { captureRuntimeSourceSnapshot, indexRuntimeCodeGraph, scanRuntimeSourceInventory } from "./project-source-snapshot.ts";
import { projectAnalysisIdentity } from "./project-analysis-identity.ts";
import { indexedEvent, projectPublishedEvent } from "./server-events.ts";

const FindingSeverity = {
  Error: "error",
} as const;
const SnapshotFindingKind = {
  Violation: "violation",
  Warning: "warning",
} as const;

const SnapshotValidator = {
  Id: "runtime-snapshot",
  Severity: "warning",
} as const;

export type RuntimeSnapshot = {
  health: RuntimeHealth;
  state: RuntimeState;
  files: string[];
  areas: SnapshotArea[];
  specs: SnapshotSpec[];
  changes: SnapshotChange[];
  conventions: SnapshotConvention[];
  docs: DocSnippet[];
  graph: RepoGraph;
  facts: CodeFileFacts[];
  findings: CanonFinding[];
  definitionGraph: DefinitionGraph;
  /** Per-validator run/skip/error outcomes (producer skips, runtime errors). NOT findings. */
  validatorOutcomes: ValidatorOutcome[];
  /** The producer state+generation that backed this snapshot's validation. */
  producerSnapshot: ProducerSnapshot;
  semanticIndex: SemanticIndexSnapshot;
  impactSurfaces: SnapshotImpactSurface[];
  validators: Array<{
    id: string;
    severity: Validator["severity"];
    scope: Validator["scope"];
    domain: Validator["domain"];
    facts: Validator["facts"];
    analysisGlobs: string[];
    topics: string[];
    appliesScopes: string[][];
    conventionIds: string[];
    docs: string[];
    summary?: string;
    visuals: Array<{ kind: "tree"; title?: string; definition: unknown }>;
  }>;
};

export function refreshChangeActivitySnapshot(input: {
  snapshot: RuntimeSnapshot;
  changeCatalog: RuntimeChangeCatalog;
  store: ProjectStore;
}): RuntimeSnapshot {
  const taskLeases = activeTaskLeaseSummaries(input.changeCatalog.rootDir);
  const histories = listCompleteChangeHistories(
    input.changeCatalog.rootDir,
    input.store,
    input.changeCatalog.changes.map((change) => change.id),
  );
  const changes = input.changeCatalog.changes.map((change) =>
    snapshotChange(input.changeCatalog.rootDir, input.changeCatalog.changesPath, change, {
      events: histories.byChangeId.get(change.id) ?? [],
      findings: input.snapshot.findings,
      taskLeases,
    }),
  );
  return { ...input.snapshot, changes };
}

export function prepareRuntimeAnalysisPublication(input: {
  analysis: RuntimeAnalysis;
  store: ProjectStore;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
}): { snapshot: RuntimeSnapshot; productModel: ProductModelProjection } {
  const semanticIndex = cachedSemanticIndexSnapshot({
    scan: { inventoryHash: input.analysis.publication.sourceInventoryHash },
    store: input.store,
    semanticEmbedding: input.semanticEmbedding,
  });
  const snapshotWithServingState = refreshChangeActivitySnapshot({
    snapshot: {
      ...input.analysis.snapshot,
      semanticIndex,
      state: { ...input.analysis.snapshot.state, semanticIndex },
    },
    changeCatalog: input.analysis.publication.changeCatalog,
    store: input.store,
  });
  const productModel = buildProductModelProjection({
    areas: snapshotWithServingState.areas,
    specs: snapshotWithServingState.specs,
    changes: snapshotWithServingState.changes,
    conventions: snapshotWithServingState.conventions,
    impactSurfaces: snapshotWithServingState.impactSurfaces,
    validators: snapshotWithServingState.validators,
    definitionGraph: snapshotWithServingState.definitionGraph,
  });
  return {
    productModel,
    snapshot: {
      ...snapshotWithServingState,
      state: {
        ...snapshotWithServingState.state,
        productModel: {
          ...productModel.counts,
          graphHash: productModel.graphHash,
          definitionsHash: productModel.definitionsHash,
          indexedAt: productModel.indexedAt,
        },
      },
    },
  };
}

export function buildProjectSummary(input: { rootDir: string; snapshot: RuntimeSnapshot; store: ProjectStore; lifecycle: RuntimeProjectSummary["lifecycle"] }): RuntimeProjectSummary {
  const storeState = input.store.readState();
  const latestQuery = { mode: CanonEventQueryMode.Recent, limit: 1 } as const;
  const latestEvent = mergeCanonEvents([...input.store.listEvents(latestQuery), ...listGlobalCanonEvents(input.rootDir, latestQuery)], 1)[0];
  const semanticIndex = input.snapshot.state.semanticIndex ?? input.snapshot.semanticIndex ?? storeState.semanticIndex;
  const productModel = input.snapshot.state.productModel ?? storeState.productModel;
  return {
    rootDir: input.rootDir,
    lifecycle: input.lifecycle,
    health: summarizeRuntimeHealth(input.snapshot.health),
    files: input.snapshot.state.files,
    findings: input.snapshot.state.findings,
    staleFiles: input.snapshot.state.staleFiles,
    ...(storeState.graphHash ? { graphHash: storeState.graphHash } : {}),
    ...(storeState.lastIndexedAt ? { lastIndexedAt: storeState.lastIndexedAt } : {}),
    ...(semanticIndex ? { semanticIndex } : {}),
    ...(productModel ? { productModel } : {}),
    ...(latestEvent ? { latestEvent } : {}),
  };
}

type CodeFileFacts = Pick<FileFacts, "path" | "imports" | "exports" | "symbols">;
export type SnapshotValidator = RuntimeSnapshot["validators"][number];
export type SnapshotAreaCheckKind = NonNullable<Area["checks"]>[number]["kind"];
export type SnapshotChangeCheckKind = NonNullable<Change["checks"]>[number]["kind"];
export type SnapshotSpecCheckKind = NonNullable<Spec["checks"]>[number]["kind"];
export type SnapshotChangeBoardColumn = "planned" | "running" | "review" | "blocked" | "ready" | "closed";
export type SnapshotChangeTask = Omit<ChangeTaskState, "updates"> & {
  updates: {
    areas: string[];
    specs: string[];
    conventions: string[];
    surfaces: string[];
    docs: string[];
  };
};
export type SnapshotArea = {
  id: string;
  title: string;
  summary: string;
  surfaces: string[];
  owns: DefinitionTarget[];
  storyCount: number;
  behaviorCount: number;
  checks: Array<{ id: string; kind: SnapshotAreaCheckKind }>;
  dependsOn: string[];
  docs: string[];
  render: Area["render"]["kind"];
  source: string;
};
export type SnapshotChange = {
  id: string;
  title: string;
  kind: Change["kind"];
  summary: string;
  intent: {
    problem: string;
    outcome: string;
    why?: string;
  };
  updates: {
    areas: string[];
    specs: string[];
    conventions: string[];
    surfaces: string[];
    docs: string[];
  };
  scope: DefinitionTarget[];
  planCount: number;
  taskCount: number;
  readyTaskCount: number;
  blockedTaskCount: number;
  tasks: SnapshotChangeTask[];
  checks: Array<{ id: string; kind: SnapshotChangeCheckKind }>;
  dependsOn: string[];
  blockedBy: string[];
  docs: string[];
  render: Change["render"]["kind"];
  source: string;
  boardColumn: SnapshotChangeBoardColumn;
  lastEvent?: {
    type: CanonEvent["type"];
    timestamp: string;
    summary: string;
  };
};
export type SnapshotSpec = {
  id: string;
  title: string;
  summary: string;
  surfaces: string[];
  areas: string[];
  scope: DefinitionTarget[];
  ruleCount: number;
  scenarioCount: number;
  checks: Array<{ id: string; kind: SnapshotSpecCheckKind }>;
  dependsOn: string[];
  governedBy: string[];
  docs: string[];
  render: Spec["render"]["kind"];
  source: string;
};
export type SnapshotImpactSurface = ImpactSurface & {
  areaIds: string[];
  specIds: string[];
  changeIds: string[];
};
export type SnapshotConvention = {
  id: string;
  title: string;
  topics: string[];
  applies: string[];
  rule: string;
  why?: string;
  related: string[];
  impactSurfaces: string[];
  docs: string[];
  runtime: Convention["runtime"]["kind"];
  render: Convention["render"]["kind"];
  source: string;
};

export type RelatedCanonQuery = {
  files?: string[];
  topics?: string[];
  conventionIds?: string[];
  validatorIds?: string[];
  findingIds?: string[];
};

export type RelatedCanon = {
  root: string;
  query: {
    files: string[];
    topics: string[];
    conventions: string[];
    validators: string[];
    findings: string[];
  };
  matchedTopics: string[];
  docs: DocSnippet[];
  areas: SnapshotArea[];
  specs: SnapshotSpec[];
  changes: SnapshotChange[];
  conventions: SnapshotConvention[];
  validators: Array<{
    id: string;
    topics: string[];
    applies: string[];
    severity: SnapshotValidator["severity"];
    scope: SnapshotValidator["scope"];
    domain: SnapshotValidator["domain"];
    facts: SnapshotValidator["facts"];
    conventionIds: string[];
    docs: string[];
    summary?: string;
  }>;
  findings: CanonFinding[];
  impactSurfaces: ImpactSurface[];
};

export type RuntimeChangeCatalog = {
  rootDir: string;
  changesPath: string;
  changes: Change[];
};

export type RuntimeStartupState = {
  snapshot: RuntimeSnapshot;
  changeCatalog: RuntimeChangeCatalog;
};

export async function buildStartupRuntimeState(input: {
  cwd: string;
  engine: Engine;
  store: ProjectStore;
}): Promise<RuntimeStartupState> {
  const project = await loadProjectContext(input.cwd);
  const taskLeases = activeTaskLeaseSummaries(project.paths.rootDir);
  const changeHistories = listCompleteChangeHistories(project.paths.rootDir, input.store, project.changes.map((change) => change.id));
  const findings: CanonFinding[] = [];
  const areas: SnapshotArea[] = project.areas.map((area) => snapshotArea(project.paths.rootDir, project.paths.areasPath, area));
  const specs: SnapshotSpec[] = project.specs.map((spec) => snapshotSpec(project.paths.rootDir, project.paths.specsPath, spec));
  const changes: SnapshotChange[] = project.changes.map((change) =>
    snapshotChange(project.paths.rootDir, project.paths.changesPath, change, {
      events: changeHistories.byChangeId.get(change.id) ?? [],
      findings,
      taskLeases,
    }),
  );
  const conventions: SnapshotConvention[] = project.conventions.map((convention) => snapshotConvention(project.paths.rootDir, project.paths.conventionsPath, convention));
  const impactSurfaces: SnapshotImpactSurface[] = snapshotImpactSurfaces(project.impactSurfaces, project.areas, project.specs, project.changes);
  const validators = project.validators.map((validator) => ({
    id: validator.id,
    severity: validator.severity,
    scope: validator.scope,
    domain: validator.domain,
    facts: validator.facts,
    analysisGlobs: validator.analysisGlobs,
    topics: validator.topics,
    appliesScopes: validator.appliesScopes,
    conventionIds: validator.conventionIds,
    docs: validator.docs,
    summary: validator.summary,
    visuals: validator.visuals.map((visual) => ({ kind: visual.kind, title: visual.title, definition: visual.definition })),
  }));
  const definitionGraph = buildDefinitionGraph({
    areas: project.areas,
    specs: project.specs,
    changes: project.changes,
    conventions: project.conventions,
    impactSurfaces: project.impactSurfaces,
    validators: project.validators.map((validator) => ({ id: validator.id, conventionIds: validator.conventionIds })),
  });
  definitionGraph.fileCoverage = buildSnapshotFileCoverage({
    files: [],
    areas,
    specs,
    changes,
    conventions,
    impactSurfaces,
  });
  const productModel = buildProductModelProjection({
    areas,
    specs,
    changes,
    conventions,
    impactSurfaces,
    validators,
    definitionGraph,
  });
  const semanticIndex = cachedStartupSemanticIndexSnapshot(input.store, project.paths.semanticEmbedding);
  const graph: RepoGraph = {
    rootDir: project.paths.rootDir,
    graphHash: createHash("sha256").update(`startup:${productModel.graphHash}:${productModel.definitionsHash}`).digest("hex"),
    files: [],
    packages: [],
    importEdges: [],
  };
  const conventionDocsByReference = docsByConvention(project.conventions);
  const health: RuntimeHealth = {
    status: "stale",
    engine: input.engine.version(),
    refresh: input.store.project.status().refresh,
    startedAt: new Date().toISOString(),
    validatorGraph: {
      entrypoint: project.validatorGraph.entrypoint,
      hash: project.validatorGraph.hash,
      loadedAt: project.validatorGraph.loadedAt,
      validatorCount: project.validatorGraph.validatorCount,
      dependencyFiles: project.validatorGraph.dependencyFiles,
    },
  };
  const storeState = input.store.readState();
  const snapshot: RuntimeSnapshot = {
    health,
    state: {
      health,
      files: storeState.files,
      findings: storeState.findings,
      staleFiles: storeState.staleFiles,
      cacheHits: 0,
      cacheMisses: 0,
      semanticIndex,
      productModel: {
        ...productModel.counts,
        graphHash: productModel.graphHash,
        definitionsHash: productModel.definitionsHash,
        indexedAt: productModel.indexedAt,
      },
    },
    files: [],
    areas,
    specs,
    changes,
    conventions,
    docs: resolveDocsReferences(project.paths, [...conventionDocsByReference.keys()], conventionDocsByReference),
    graph,
    facts: [],
    findings,
    definitionGraph,
    validatorOutcomes: [],
    producerSnapshot: {},
    semanticIndex,
    impactSurfaces,
    validators,
  };
  return {
    snapshot,
    changeCatalog: {
      rootDir: project.paths.rootDir,
      changesPath: project.paths.changesPath,
      changes: project.changes,
    },
  };
}

export type RuntimeAnalysis = {
  snapshot: RuntimeSnapshot;
  publication: {
    codeGraphGeneration: string;
    analysisInputHash: string;
    sourceInventoryHash: string;
    productModel: ProductModelProjection;
    changeCatalog: RuntimeChangeCatalog;
  };
};

export const RuntimeAnalysisOutcomeKind = {
  Unchanged: "unchanged",
  Candidate: "candidate",
} as const;

export type RuntimeAnalysisOutcome =
  | { kind: typeof RuntimeAnalysisOutcomeKind.Unchanged; analysisInputHash: string; sourceInventoryHash: string }
  | { kind: typeof RuntimeAnalysisOutcomeKind.Candidate; analysis: RuntimeAnalysis };

type RuntimeSnapshotInput = {
  cwd: string;
  engine: Engine;
  store: ProjectStore;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
  producerPolicy?: ProducerPolicy;
  validationResultCache: ValidationResultCache;
};

type RuntimeAnalysisInput = Omit<RuntimeSnapshotInput, "store"> & {
  store: ProjectAnalysisStore;
};

export async function buildRuntimeSnapshot(input: RuntimeSnapshotInput): Promise<RuntimeSnapshot> {
  const analysis = await buildRuntimeAnalysis(input);
  const revision = input.store.publication().revision + 1;
  const summary = "Built Project State snapshot.";
  input.store.publishProjectState({
    revision,
    codeGraphGeneration: analysis.publication.codeGraphGeneration,
    snapshot: {
      health: analysis.snapshot.health,
      files: analysis.snapshot.files,
      graph: analysis.snapshot.graph,
      findings: analysis.snapshot.findings,
      staleFiles: analysis.snapshot.state.staleFiles,
      productModel: analysis.publication.productModel,
    },
    canonEvent: indexedEvent(analysis.snapshot, summary),
    protocolEvent: {
      ...projectPublishedEvent(summary),
      timestamp: new Date().toISOString(),
      revision,
    },
  });
  return analysis.snapshot;
}

export async function buildRuntimeAnalysis(input: RuntimeAnalysisInput): Promise<RuntimeAnalysis> {
  const outcome = await buildRuntimeAnalysisOutcome(input);
  if (outcome.kind !== RuntimeAnalysisOutcomeKind.Candidate) {
    throw new Error("Project analysis unexpectedly returned unchanged without a previous source identity.");
  }
  return outcome.analysis;
}

export async function buildRuntimeAnalysisOutcome(
  input: RuntimeAnalysisInput & { previousAnalysisInputHash?: string },
): Promise<RuntimeAnalysisOutcome> {
  const project = await loadProjectContext(input.cwd);
  const inventory = scanRuntimeSourceInventory({ paths: project.paths, store: input.store });
  const analysisIdentity = projectAnalysisIdentity({ project, sourceInventoryHash: inventory.scan.inventoryHash });
  if (input.previousAnalysisInputHash && analysisIdentity.hash === input.previousAnalysisInputHash) {
    return {
      kind: RuntimeAnalysisOutcomeKind.Unchanged,
      analysisInputHash: analysisIdentity.hash,
      sourceInventoryHash: analysisIdentity.sourceInventoryHash,
    };
  }
  const sourceSnapshot = captureRuntimeSourceSnapshot({
    rootDir: project.paths.rootDir,
    paths: project.paths,
    store: input.store,
    inventory,
  });
  const { discovery, scan, fileSnapshots, factFiles, facts } = sourceSnapshot;
  const codeGraph = await indexRuntimeCodeGraph({
    store: input.store,
    factFiles,
  });

  const engineGraph = input.store.project.buildRepoGraph({
    facts,
    packageManifests: discovery.files.filter((file) => path.basename(file) === "package.json"),
  }).graph;
  const validationContext = createValidationContext({
    rootDir: project.rootDir,
    paths: project.paths,
    files: discovery.files,
    analysisFiles: discovery.files,
    projectFileSnapshots: fileSnapshots,
    validator: {
      id: SnapshotValidator.Id,
      severity: SnapshotValidator.Severity,
    },
  });
  const graph: RepoGraph = {
    ...engineGraph,
    importEdges: validationContext.imports().map((edge) => ({
      from: edge.from.path,
      source: edge.source,
      to: edge.resolvedPath,
      resolution: edge.resolution,
      fromPackage: edge.fromPackage,
      toPackage: edge.toPackage,
    })),
  };
  const validation = await runValidation({
    rootDir: project.rootDir,
    paths: project.paths,
    conventions: project.conventions,
    areas: project.areas,
    specs: project.specs,
    changes: project.changes,
    validators: project.validators,
    project: true,
    producerPolicy: input.producerPolicy ?? BatchProducerPolicy,
    projectFileSnapshots: fileSnapshots,
    resultCache: input.validationResultCache,
  });

  const health: RuntimeHealth = {
    status: validation.diagnostics.length > 0 ? "failed" : "ready",
    engine: input.engine.version(),
    refresh: input.store.project.status().refresh,
    startedAt: new Date().toISOString(),
    validatorGraph: {
      entrypoint: project.validatorGraph.entrypoint,
      hash: project.validatorGraph.hash,
      loadedAt: project.validatorGraph.loadedAt,
      validatorCount: project.validatorGraph.validatorCount,
      dependencyFiles: project.validatorGraph.dependencyFiles,
    },
  };
  const validatorById = new Map(project.validators.map((validator) => [validator.id, validator]));
  const conventionIdsByValidator = conventionsByValidator(project.conventions);
  const conventionDocsByReference = docsByConvention(project.conventions);
  const findingIdCounts = new Map<string, number>();
  const findings = validation.findings.map((finding): CanonFinding => {
    const docs = finding.docs ?? [];
    const conventionIds = unique([
      ...(validatorById.get(finding.validatorId)?.conventionIds ?? []),
      ...(conventionIdsByValidator.get(finding.validatorId) ?? []),
      ...(finding.conventionIds ?? []),
    ]);
    const baseId = findingSnapshotId({ ...finding, docs, conventionIds });
    const duplicateCount = (findingIdCounts.get(baseId) ?? 0) + 1;
    findingIdCounts.set(baseId, duplicateCount);

    return {
      id: duplicateCount === 1 ? baseId : `${baseId}-${duplicateCount}`,
      kind: finding.severity === FindingSeverity.Error ? SnapshotFindingKind.Violation : SnapshotFindingKind.Warning,
      severity: finding.severity,
      validatorId: finding.validatorId,
      title: finding.validatorId,
      message: finding.message,
      file: finding.file,
      line: finding.line,
      column: finding.column,
      docs,
      conventionIds,
      fix: finding.fix
        ? {
            type: finding.fix.safety === FixSafety.Safe ? "safe" : finding.fix.safety === FixSafety.Suggested ? "unsafe" : "manual",
            description: finding.fix.description,
          }
        : undefined,
    };
  });
  const definitionGraph = buildDefinitionGraph({
    areas: project.areas,
    specs: project.specs,
    changes: project.changes,
    conventions: project.conventions,
    impactSurfaces: project.impactSurfaces,
    validators: project.validators.map((validator) => ({ id: validator.id, conventionIds: validator.conventionIds })),
  });

  const taskLeases = activeTaskLeaseSummaries(project.paths.rootDir);
  const changeHistories = listCompleteChangeHistories(project.paths.rootDir, input.store, project.changes.map((change) => change.id));
  const areas: SnapshotArea[] = project.areas.map((area) => snapshotArea(project.paths.rootDir, project.paths.areasPath, area));
  const specs: SnapshotSpec[] = project.specs.map((spec) => snapshotSpec(project.paths.rootDir, project.paths.specsPath, spec));
  const changes: SnapshotChange[] = project.changes.map((change) =>
    snapshotChange(project.paths.rootDir, project.paths.changesPath, change, {
      events: changeHistories.byChangeId.get(change.id) ?? [],
      findings,
      taskLeases,
    }),
  );
  const conventions: SnapshotConvention[] = project.conventions.map((convention) => snapshotConvention(project.paths.rootDir, project.paths.conventionsPath, convention));
  const impactSurfaces: SnapshotImpactSurface[] = snapshotImpactSurfaces(project.impactSurfaces, project.areas, project.specs, project.changes);
  definitionGraph.fileCoverage = buildSnapshotFileCoverage({
    files: discovery.files,
    areas,
    specs,
    changes,
    conventions,
    impactSurfaces,
  });
  const validators: SnapshotValidator[] = project.validators.map((validator) => ({
    id: validator.id,
    severity: validator.severity,
    scope: validator.scope,
    domain: validator.domain,
    facts: validator.facts,
    analysisGlobs: validator.analysisGlobs,
    topics: validator.topics,
    appliesScopes: validator.appliesScopes,
    conventionIds: validator.conventionIds,
    docs: validator.docs,
    summary: validator.summary,
    visuals: validator.visuals.map((visual) => ({ kind: visual.kind, title: visual.title, definition: visual.definition })),
  }));
  const productModel = buildProductModelProjection({
    areas,
    specs,
    changes,
    conventions,
    impactSurfaces,
    validators,
    definitionGraph,
  });
  const semanticIndexSnapshot = cachedSemanticIndexSnapshot({
    scan,
    store: input.store,
    semanticEmbedding: input.semanticEmbedding ?? project.paths.semanticEmbedding,
  });
  const snapshot: RuntimeSnapshot = {
    health,
    state: {
      health,
      files: discovery.files.length,
      findings: findings.length,
      staleFiles: scan.staleFiles,
      cacheHits: 0,
      cacheMisses: scan.changedFiles.length + scan.deletedFiles.length,
      semanticIndex: semanticIndexSnapshot,
      productModel: {
        ...productModel.counts,
        graphHash: productModel.graphHash,
        definitionsHash: productModel.definitionsHash,
        indexedAt: productModel.indexedAt,
      },
    },
    files: discovery.files,
    areas,
    specs,
    changes,
    conventions,
    docs: resolveDocsReferences(project.paths, [...conventionDocsByReference.keys()], conventionDocsByReference),
    graph,
    facts: facts.map((file) => ({
      path: file.path,
      imports: file.imports,
      exports: file.exports,
      symbols: file.symbols,
    })),
    findings,
    definitionGraph,
    validatorOutcomes: validation.validatorOutcomes,
    producerSnapshot: validation.producerSnapshot,
    semanticIndex: semanticIndexSnapshot,
    impactSurfaces,
    validators,
  };
  return {
    kind: RuntimeAnalysisOutcomeKind.Candidate,
    analysis: {
      snapshot,
      publication: {
        codeGraphGeneration: codeGraph.generation,
        analysisInputHash: analysisIdentity.hash,
        sourceInventoryHash: scan.inventoryHash,
        productModel,
        changeCatalog: {
          rootDir: project.paths.rootDir,
          changesPath: project.paths.changesPath,
          changes: project.changes,
        },
      },
    },
  };
}

export { buildRelatedCanon, findingSnapshotId, gitDiffSnapshot, gitHistorySnapshot, runtimeSnapshotFailure } from "./snapshot-related.ts";
