import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createValidationContext,
  DiagnosticSeverity,
  DefaultSemanticIndexId,
  SemanticChunkerVersion,
  SemanticEmbeddingProducerVersion,
  SemanticIndexVersion,
  buildDefinitionGraph,
  FixSafety,
  InteractiveProducerPolicy,
  discoverProjectFiles,
  loadProjectContext,
  isEngineExtractableFile,
  isCodeGraphIndexableFile,
  engineSourceLanguage,
  resolveDocsReferences,
  runValidation,
  semanticChunkTreeHash,
  semanticEmbeddingIdentityHash,
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
  type FactDiagnostic,
  type FileFacts,
  type FactKind,
  type ImpactSurface,
  type RuntimeProjectSummary,
  type ChangeTaskState,
  type RepoGraph,
  type SemanticEmbeddingConfig,
  type SemanticChunkMetadata,
  type SemanticIndexSnapshot,
  type ValidationResultCache,
  type Validator,
  type ValidatorOutcome,
  type ProducerSnapshot,
} from "@opencanon/core";
import type { Engine } from "@opencanon/engine";
import type { ProjectStore } from "./state.ts";
import { ENGINE_PARSER_VERSION } from "./ast-facts-provider.ts";
import { buildProjectSemanticIndex, localHashEmbeddingProvider } from "./semantic-index.ts";
import { activeTaskLeaseSummaries, listGlobalCanonEvents, mergeCanonEvents } from "./worktree-coordination.ts";
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

const allFactKinds: FactKind[] = ["imports", "exports", "symbols", "calls", "literals", "comments"];

const FindingSeverity = {
  Error: "error",
} as const;
const SemanticChunkMetadataPageSize = 500;

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

export function buildProjectSummary(input: { rootDir: string; snapshot: RuntimeSnapshot; store: ProjectStore }): RuntimeProjectSummary {
  const storeState = input.store.readState();
  const latestEvent = mergeCanonEvents([...input.store.listEvents(1), ...listGlobalCanonEvents(input.rootDir, 1)], 1)[0];
  const semanticIndex = input.snapshot.state.semanticIndex ?? input.snapshot.semanticIndex ?? storeState.semanticIndex;
  const productModel = input.snapshot.state.productModel ?? storeState.productModel;
  return {
    rootDir: input.rootDir,
    health: input.snapshot.health,
    files: storeState.files,
    findings: storeState.findings,
    staleFiles: storeState.staleFiles,
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

export async function buildRuntimeSnapshot(input: {
  cwd: string;
  engine: Engine;
  store: ProjectStore;
  semanticEmbedding?: SemanticEmbeddingConfig | undefined;
  semanticIndexMode?: "build" | "reuse";
  validationResultCache: ValidationResultCache;
}): Promise<RuntimeSnapshot> {
  const project = await loadProjectContext(input.cwd);
  const discovery = discoverProjectFiles(project.paths);
  if (discovery.failed) {
    throw new Error(discovery.diagnostics.join("\n"));
  }

  const scan = input.store.scanAndDiff(discovery.files);
  // Read each AST-fact source ONCE here and pass its content + hash to the engine, so the
  // facts are parsed from and labelled with the exact same bytes (no scan→extract
  // disk-reread TOCTOU). A file deleted/unreadable since discovery is skipped.
  const factFiles = scan.files
    .filter((file) => isEngineExtractableFile(file.path))
    .map((file) => {
      try {
        const content = readFileSync(path.join(project.paths.rootDir, file.path), "utf8");
        return { path: file.path, contentHash: createHash("sha256").update(content).digest("hex"), language: engineSourceLanguage(file.path), content };
      } catch {
        return undefined;
      }
    })
    .filter((file): file is NonNullable<typeof file> => file !== undefined);
  const facts = input.store.project.extractFacts({
    files: factFiles,
    facts: allFactKinds,
    parserVersion: ENGINE_PARSER_VERSION,
  });
  input.store.project.indexCodeGraph({
    files: factFiles.filter((file) => isCodeGraphIndexableFile(file.path)),
    deletedFiles: scan.deletedFiles.filter(isCodeGraphIndexableFile),
    parserVersion: ENGINE_PARSER_VERSION,
  });
  const factDiagnostics = [
    ...facts.diagnostics,
    ...facts.files.flatMap((file) => file.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${file.path}: ${diagnostic.message}` }))),
  ] satisfies FactDiagnostic[];
  if (factDiagnostics.some((diagnostic) => diagnostic.severity === FindingSeverity.Error)) {
    throw new Error(factDiagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }

  const engineGraph = input.store.project.buildRepoGraph({
    facts: facts.files,
    packageManifests: discovery.files.filter((file) => path.basename(file) === "package.json"),
  }).graph;
  const validationContext = createValidationContext({
    rootDir: project.rootDir,
    paths: project.paths,
    files: discovery.files,
    analysisFiles: discovery.files,
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
    producerPolicy: InteractiveProducerPolicy,
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

  const recentEvents = mergeCanonEvents([...input.store.listEvents(200), ...listGlobalCanonEvents(project.paths.rootDir, 200)], 200);
  const taskLeases = activeTaskLeaseSummaries(project.paths.rootDir);
  const areas: SnapshotArea[] = project.areas.map((area) => snapshotArea(project.paths.rootDir, project.paths.areasPath, area));
  const specs: SnapshotSpec[] = project.specs.map((spec) => snapshotSpec(project.paths.rootDir, project.paths.specsPath, spec));
  const changes: SnapshotChange[] = project.changes.map((change) =>
    snapshotChange(project.paths.rootDir, project.paths.changesPath, change, {
      events: recentEvents,
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
  let semanticIndexSnapshot: SemanticIndexSnapshot;
  if (input.semanticIndexMode === "reuse") {
    semanticIndexSnapshot = cachedSemanticIndexSnapshot({
      scan,
      store: input.store,
    });
  } else {
    let semanticIndex = buildProjectSemanticIndex({
      rootDir: project.paths.rootDir,
      scan,
      facts: facts.files,
      project: input.store.project,
      semanticEmbedding: input.semanticEmbedding ?? project.paths.semanticEmbedding,
      previousChunks: listPreviousSemanticChunks(input.store),
    });

    try {
      input.store.writeSemanticIndex(semanticIndex);
    } catch (error) {
      if (!isRecoverableSemanticVectorWriteError(error)) {
        throw error;
      }
      semanticIndex = buildProjectSemanticIndex({
        rootDir: project.paths.rootDir,
        scan,
        facts: facts.files,
        project: input.store.project,
        semanticEmbedding: input.semanticEmbedding ?? project.paths.semanticEmbedding,
        previousChunks: [],
      });
      input.store.writeSemanticIndex(semanticIndex);
    }
    semanticIndexSnapshot = input.store.readSemanticIndexStatus({ indexId: DefaultSemanticIndexId }).index ?? semanticIndex.index;
  }
  input.store.writeSnapshot({ health, files: discovery.files, graph, findings, productModel });
  const storeState = input.store.readState();

  return {
    health,
    state: {
      health,
      files: storeState.files,
      findings: storeState.findings,
      staleFiles: storeState.staleFiles,
      cacheHits: 0,
      cacheMisses: scan.changedFiles.length + scan.deletedFiles.length,
      semanticIndex: semanticIndexSnapshot,
      ...(storeState.productModel ? { productModel: storeState.productModel } : {}),
    },
    files: discovery.files,
    areas,
    specs,
    changes,
    conventions,
    docs: resolveDocsReferences(project.paths, [...conventionDocsByReference.keys()], conventionDocsByReference),
    graph,
    facts: facts.files.map((file) => ({
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
}

function listPreviousSemanticChunks(store: ProjectStore): SemanticChunkMetadata[] {
  const chunks: SemanticChunkMetadata[] = [];
  for (let offset = 0; ; offset += SemanticChunkMetadataPageSize) {
    const page = store.listSemanticChunks({
      indexId: DefaultSemanticIndexId,
      limit: SemanticChunkMetadataPageSize,
      offset,
    });
    chunks.push(...page.chunks);
    if (page.chunks.length < SemanticChunkMetadataPageSize) return chunks;
  }
}

function cachedSemanticIndexSnapshot(input: {
  scan: { inventoryHash: string };
  store: ProjectStore;
}): SemanticIndexSnapshot {
  const previous = input.store.readSemanticIndexStatus({ indexId: DefaultSemanticIndexId }).index;
  if (previous) {
    const sourceCurrent = previous.sourceInventoryHash === input.scan.inventoryHash;
    return {
      ...previous,
      status: sourceCurrent ? previous.status : "stale",
      sourceInventoryHash: sourceCurrent ? previous.sourceInventoryHash : input.scan.inventoryHash,
      staleChunkCount: sourceCurrent ? previous.staleChunkCount : Math.max(previous.staleChunkCount, previous.chunkCount),
      diagnostics: sourceCurrent
        ? previous.diagnostics
        : [
            ...previous.diagnostics.filter((diagnostic) => diagnostic.code !== "semantic-index-stale-on-startup"),
            {
              code: "semantic-index-stale-on-startup",
              message: "The cached Project Context index is being refreshed by the worker.",
              severity: DiagnosticSeverity.Info,
            },
          ],
    };
  }
  const provider = localHashEmbeddingProvider();
  const identityHash = semanticEmbeddingIdentityHash({
    providerId: provider.id,
    modelId: provider.modelId,
    modelDigest: provider.modelDigest,
    dimensions: provider.dimensions,
    configHash: provider.configHash,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion: SemanticEmbeddingProducerVersion,
  });
  return {
    id: DefaultSemanticIndexId,
    version: SemanticIndexVersion,
    status: "indexing",
    provider,
    chunkerVersion: SemanticChunkerVersion,
    producerVersion: SemanticEmbeddingProducerVersion,
    sourceInventoryHash: input.scan.inventoryHash,
    chunkTreeHash: semanticChunkTreeHash([]),
    identityHash,
    chunkCount: 0,
    vectorCount: 0,
    staleChunkCount: 0,
    embeddingStats: {
      totalChunks: 0,
      embeddedChunks: 0,
      reusedChunks: 0,
    },
    indexedAt: new Date().toISOString(),
    diagnostics: [
      {
        code: "semantic-index-starting",
        message: "Project Context indexing is queued by the worker.",
        severity: DiagnosticSeverity.Info,
      },
    ],
  };
}

function isRecoverableSemanticVectorWriteError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return (
    message.includes("Database corrupted") ||
    message.includes("ID already exists") ||
    message.includes("cannot reuse a missing or changed vector") ||
    message.includes("WAL serialization error") ||
    message.includes("semantic vector store")
  );
}

export { buildRelatedCanon, findingSnapshotId, gitDiffSnapshot, gitHistorySnapshot, runtimeSnapshotFailure } from "./snapshot-related.ts";
