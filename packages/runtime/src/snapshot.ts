import path from "node:path";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  createOpenCanonDiagnostic,
  createOpenCanonFailure,
  createValidationContext,
  DiagnosticSeverity,
  AreaRenderKind,
  areaDocsReference,
  ChangeRenderKind,
  changeDocsReference,
  deriveChangeTaskStates,
  ChangeWorkStatus,
  ConventionRenderKind,
  DefaultSemanticIndexId,
  SemanticChunkerVersion,
  SemanticEmbeddingProducerVersion,
  SemanticIndexVersion,
  specDocsReference,
  buildDefinitionGraph,
  definitionTargetDocs,
  definitionTargetFiles,
  conventionDocsReference,
  FixSafety,
  InteractiveProducerPolicy,
  discoverProjectFiles,
  getGitFileDiff,
  getGitFileHistory,
  intersects,
  loadProjectContext,
  isEngineExtractableFile,
  isCodeGraphIndexableFile,
  engineSourceLanguage,
  matchesAny,
  matchesAnyFile,
  relative,
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
  type FileFacts,
  type FactKind,
  type ImpactSurface,
  type ProductModelProjection,
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
type SnapshotValidator = RuntimeSnapshot["validators"][number];
type SnapshotAreaCheckKind = NonNullable<Area["checks"]>[number]["kind"];
type SnapshotChangeCheckKind = NonNullable<Change["checks"]>[number]["kind"];
type SnapshotSpecCheckKind = NonNullable<Spec["checks"]>[number]["kind"];
type SnapshotChangeBoardColumn = "planned" | "running" | "review" | "blocked" | "ready" | "closed";
type SnapshotChangeTask = Omit<ChangeTaskState, "updates"> & {
  updates: {
    areas: string[];
    specs: string[];
    conventions: string[];
    surfaces: string[];
    docs: string[];
  };
};
type SnapshotArea = {
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
type SnapshotChange = {
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
type SnapshotSpec = {
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
type SnapshotImpactSurface = ImpactSurface & {
  areaIds: string[];
  specIds: string[];
  changeIds: string[];
};
type SnapshotConvention = {
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
  ];
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

export function buildRelatedCanon(input: { rootDir: string; paths: { conventionsPath: string; rootDir: string }; snapshot: RuntimeSnapshot; query: RelatedCanonQuery }): RelatedCanon {
  const files = unique(input.query.files ?? []);
  const topics = new Set(input.query.topics ?? []);
  const conventionIds = new Set(input.query.conventionIds ?? []);
  const validatorIds = new Set(input.query.validatorIds ?? []);
  const findingIds = new Set(input.query.findingIds ?? []);
  const docsRefs = new Set<string>();
  const conventionDocsByReference = docsBySnapshotConvention(input.snapshot.conventions);

  const findings = input.snapshot.findings.filter((finding) => {
    const matched =
      findingIds.has(finding.id) ||
      (finding.file ? files.includes(finding.file) : false) ||
      (finding.validatorId ? validatorIds.has(finding.validatorId) : false) ||
      intersects(finding.conventionIds ?? [], [...conventionIds]);
    if (matched) collectFindingContext(finding, { files, validatorIds, conventionIds, docsRefs });
    return matched;
  });

  const validators = selectRelatedValidators(input.snapshot.validators, { files, topics, conventionIds, validatorIds });
  for (const validator of validators) collectValidatorContext(validator, { topics, conventionIds, docsRefs });

  for (const finding of findings) {
    if (finding.validatorId) validatorIds.add(finding.validatorId);
  }

  const validatorsWithFindings = selectRelatedValidators(input.snapshot.validators, { files, topics, conventionIds, validatorIds });
  for (const validator of validatorsWithFindings) collectValidatorContext(validator, { topics, conventionIds, docsRefs });

  const conventions = input.snapshot.conventions.filter(
    (convention) =>
      conventionIds.has(convention.id) ||
      intersects(convention.topics, [...topics]) ||
      intersects(convention.related, [...validatorIds]) ||
      matchesAnyFile(files, convention.applies) ||
      intersects(convention.docs, [...docsRefs]),
  );
  let impactSurfaces = input.snapshot.impactSurfaces.filter(
    (surface) =>
      input.snapshot.conventions.some((convention) => conventionIds.has(convention.id) && convention.impactSurfaces.includes(surface.id)) ||
      intersects(surface.risks ?? [], [...topics]) ||
      intersects(files, surface.applies) ||
      matchesAnyFile(files, surface.applies),
  );
  const impactSurfaceIds = new Set(impactSurfaces.map((surface) => surface.id));
  for (const surface of impactSurfaces) {
    for (const convention of input.snapshot.conventions.filter((item) => item.impactSurfaces.includes(surface.id))) conventionIds.add(convention.id);
    for (const docsRef of surface.docs ?? []) docsRefs.add(docsRef);
    for (const risk of surface.risks ?? []) topics.add(risk);
  }
  for (const convention of conventions) {
    conventionIds.add(convention.id);
    for (const topic of convention.topics) topics.add(topic);
    for (const related of convention.related) {
      if (input.snapshot.validators.some((validator) => validator.id === related)) validatorIds.add(related);
      else conventionIds.add(related);
    }
    for (const docsRef of convention.docs ?? []) docsRefs.add(docsRef);
  }

  const areas = input.snapshot.areas.filter((area) => areaMatchesRelatedContext(area, { files, docsRefs, impactSurfaceIds }));
  const areaIds = new Set(areas.map((area) => area.id));
  for (const area of areas) {
    for (const docsRef of area.docs) docsRefs.add(docsRef);
    for (const surfaceId of area.surfaces) impactSurfaceIds.add(surfaceId);
  }

  const specs = input.snapshot.specs.filter((spec) =>
    specMatchesRelatedContext(spec, {
      files,
      docsRefs,
      conventionIds,
      areaIds,
      impactSurfaceIds,
    }),
  );
  const specIds = new Set(specs.map((spec) => spec.id));
  for (const spec of specs) {
    for (const docsRef of spec.docs) docsRefs.add(docsRef);
    for (const conventionId of spec.governedBy) conventionIds.add(conventionId);
    for (const areaId of spec.areas) areaIds.add(areaId);
    for (const surfaceId of spec.surfaces) impactSurfaceIds.add(surfaceId);
  }

  const changes = input.snapshot.changes.filter((change) =>
    changeMatchesRelatedContext(change, {
      files,
      docsRefs,
      conventionIds,
      areaIds,
      specIds,
      impactSurfaceIds,
    }),
  );
  for (const change of changes) {
    for (const docsRef of change.docs) docsRefs.add(docsRef);
    for (const conventionId of change.updates.conventions) conventionIds.add(conventionId);
    for (const areaId of change.updates.areas) areaIds.add(areaId);
    for (const specId of change.updates.specs) specIds.add(specId);
    for (const surfaceId of change.updates.surfaces) impactSurfaceIds.add(surfaceId);
  }

  impactSurfaces = uniqueById([...impactSurfaces, ...input.snapshot.impactSurfaces.filter((surface) => impactSurfaceIds.has(surface.id))]);

  const finalValidators = selectRelatedValidators(input.snapshot.validators, { files, topics, conventionIds, validatorIds });
  for (const validator of finalValidators) collectValidatorContext(validator, { topics, conventionIds, docsRefs });

  const matchedTopics = unique([
    ...conventions.flatMap((convention) => convention.topics),
    ...finalValidators.flatMap((validator) => validator.topics),
  ]).sort();

  return {
    root: input.rootDir,
    query: {
      files,
      topics: input.query.topics ?? [],
      conventions: input.query.conventionIds ?? [],
      validators: input.query.validatorIds ?? [],
      findings: input.query.findingIds ?? [],
    },
    matchedTopics,
    docs: resolveDocsReferences(input.paths, [...docsRefs], conventionDocsByReference),
    areas,
    specs,
    changes,
    conventions,
    validators: finalValidators.map((validator) => ({
      id: validator.id,
      topics: validator.topics,
      applies: formatAppliesScopes(validator.appliesScopes),
      severity: validator.severity,
      scope: validator.scope,
      domain: validator.domain,
      facts: validator.facts,
      conventionIds: validator.conventionIds,
      docs: validator.docs,
      summary: validator.summary,
    })),
    findings,
    impactSurfaces,
  };
}

export function gitHistorySnapshot(cwd: string, files: string[], limit: number) {
  return getGitFileHistory(cwd, files, limit);
}

export function gitDiffSnapshot(cwd: string, file: string, commit: string) {
  return getGitFileDiff(cwd, file, commit);
}

export function runtimeSnapshotFailure(error: unknown) {
  return createOpenCanonFailure([
    createOpenCanonDiagnostic({
      code: "invalid-runtime-response",
      message: error instanceof Error ? error.message : String(error),
    }),
  ]);
}

function selectRelatedValidators(
  validators: SnapshotValidator[],
  query: { files: string[]; topics: Set<string>; conventionIds: Set<string>; validatorIds: Set<string> },
): SnapshotValidator[] {
  return validators.filter(
    (validator) =>
      query.validatorIds.has(validator.id) ||
      intersects(validator.topics, [...query.topics]) ||
      intersects(validator.conventionIds, [...query.conventionIds]) ||
      validatorMatchesAnyFileMetadata(validator, query.files),
  );
}

function collectFindingContext(
  finding: CanonFinding,
  output: { files: string[]; validatorIds: Set<string>; conventionIds: Set<string>; docsRefs: Set<string> },
): void {
  if (finding.file && !output.files.includes(finding.file)) output.files.push(finding.file);
  if (finding.validatorId) output.validatorIds.add(finding.validatorId);
  for (const conventionId of finding.conventionIds ?? []) output.conventionIds.add(conventionId);
  for (const docsRef of finding.docs ?? []) output.docsRefs.add(docsRef);
}

function collectValidatorContext(
  validator: SnapshotValidator,
  output: { topics: Set<string>; conventionIds: Set<string>; docsRefs: Set<string> },
): void {
  for (const topic of validator.topics) output.topics.add(topic);
  for (const conventionId of validator.conventionIds) output.conventionIds.add(conventionId);
  for (const docsRef of validator.docs) output.docsRefs.add(docsRef);
}

function areaMatchesRelatedContext(
  area: SnapshotArea,
  context: { files: string[]; docsRefs: Set<string>; impactSurfaceIds: Set<string> },
): boolean {
  return (
    matchesAnyFile(context.files, definitionTargetFiles(area.owns)) ||
    intersects(context.files, definitionTargetDocs(area.owns)) ||
    intersects(area.docs, [...context.docsRefs]) ||
    intersects(area.surfaces, [...context.impactSurfaceIds])
  );
}

function specMatchesRelatedContext(
  spec: SnapshotSpec,
  context: {
    files: string[];
    docsRefs: Set<string>;
    conventionIds: Set<string>;
    areaIds: Set<string>;
    impactSurfaceIds: Set<string>;
  },
): boolean {
  return (
    matchesAnyFile(context.files, definitionTargetFiles(spec.scope)) ||
    intersects(context.files, definitionTargetDocs(spec.scope)) ||
    intersects(spec.docs, [...context.docsRefs]) ||
    intersects(spec.governedBy, [...context.conventionIds]) ||
    intersects(spec.areas, [...context.areaIds]) ||
    intersects(spec.surfaces, [...context.impactSurfaceIds])
  );
}

function changeMatchesRelatedContext(
  change: SnapshotChange,
  context: {
    files: string[];
    docsRefs: Set<string>;
    conventionIds: Set<string>;
    areaIds: Set<string>;
    specIds: Set<string>;
    impactSurfaceIds: Set<string>;
  },
): boolean {
  const taskFiles = change.tasks.flatMap((task) => task.files);
  const taskSurfaceIds = unique(change.tasks.flatMap((task) => [...task.surfaces, ...task.updates.surfaces]));
  const taskAreaIds = unique(change.tasks.flatMap((task) => task.updates.areas));
  const taskSpecIds = unique(change.tasks.flatMap((task) => task.updates.specs));
  const taskConventionIds = unique(change.tasks.flatMap((task) => task.updates.conventions));
  const taskDocsRefs = unique(change.tasks.flatMap((task) => task.updates.docs));
  return (
    matchesAnyFile(context.files, definitionTargetFiles(change.scope)) ||
    matchesAnyFile(context.files, taskFiles) ||
    intersects(context.files, definitionTargetDocs(change.scope)) ||
    intersects(change.docs, [...context.docsRefs]) ||
    intersects(taskDocsRefs, [...context.docsRefs]) ||
    intersects(change.updates.conventions, [...context.conventionIds]) ||
    intersects(taskConventionIds, [...context.conventionIds]) ||
    intersects(change.updates.areas, [...context.areaIds]) ||
    intersects(taskAreaIds, [...context.areaIds]) ||
    intersects(change.updates.specs, [...context.specIds]) ||
    intersects(taskSpecIds, [...context.specIds]) ||
    intersects(change.updates.surfaces, [...context.impactSurfaceIds]) ||
    intersects(taskSurfaceIds, [...context.impactSurfaceIds])
  );
}

function validatorMatchesAnyFileMetadata(validator: SnapshotValidator, files: string[]): boolean {
  return files.some((file) => validatorMatchesFileMetadata(validator, file));
}

function validatorMatchesFileMetadata(validator: SnapshotValidator, file: string): boolean {
  return validator.appliesScopes.length === 0 || validator.appliesScopes.every((patterns) => matchesAny(file, patterns));
}

function formatAppliesScopes(scopes: string[][]): string[] {
  if (scopes.length === 0) return ["<project>"];
  if (scopes.length === 1) return scopes[0];
  return [scopes.map((patterns) => patterns.join(", ")).join(" && ")];
}

export function findingSnapshotId(finding: Pick<CanonFinding, "validatorId" | "file" | "line" | "column" | "severity" | "message" | "docs" | "conventionIds">): string {
  const validatorId = finding.validatorId ?? "unknown-validator";
  const hash = createHash("sha256")
    .update(
      JSON.stringify({
        validatorId,
        file: finding.file ?? "",
        line: finding.line ?? 0,
        column: finding.column ?? 0,
        severity: finding.severity,
        message: finding.message,
        docs: finding.docs ?? [],
        conventionIds: finding.conventionIds ?? [],
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${validatorId}:${hash}`;
}

function buildProductModelProjection(input: {
  areas: SnapshotArea[];
  specs: SnapshotSpec[];
  changes: SnapshotChange[];
  conventions: SnapshotConvention[];
  impactSurfaces: SnapshotImpactSurface[];
  validators: SnapshotValidator[];
  definitionGraph: DefinitionGraph;
}): ProductModelProjection {
  const definitions = {
    areas: input.areas,
    specs: input.specs,
    changes: input.changes,
    conventions: input.conventions,
    impactSurfaces: input.impactSurfaces,
    validators: input.validators,
  };
  return {
    indexedAt: new Date().toISOString(),
    graphHash: stableJsonHash(input.definitionGraph),
    definitionsHash: stableJsonHash(definitions),
    counts: {
      areas: input.areas.length,
      specs: input.specs.length,
      changes: input.changes.length,
      conventions: input.conventions.length,
      impactSurfaces: input.impactSurfaces.length,
      validators: input.validators.length,
      nodes: input.definitionGraph.nodes.length,
      edges: input.definitionGraph.edges.length,
      diagnostics: input.definitionGraph.diagnostics.length,
    },
    ...definitions,
    definitionGraph: input.definitionGraph,
  };
}

function stableJsonHash(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function uniqueById<T extends { id: string }>(values: T[]): T[] {
  return [...new Map(values.map((value) => [value.id, value])).values()];
}

function conventionsByValidator(conventions: Convention[]): Map<string, string[]> {
  const byValidator = new Map<string, string[]>();
  for (const convention of conventions) {
    for (const validatorId of convention.related ?? []) {
      const values = byValidator.get(validatorId) ?? [];
      values.push(convention.id);
      byValidator.set(validatorId, values);
    }
  }
  return byValidator;
}

function docsByConvention(conventions: Convention[]): Map<string, string[]> {
  const byReference = new Map<string, string[]>();
  for (const convention of conventions) {
    if (convention.render.kind === ConventionRenderKind.None) continue;
    const docsRef = conventionDocsReference(convention)!;
    const values = byReference.get(docsRef) ?? [];
    values.push(convention.id);
    byReference.set(docsRef, values);
  }
  return byReference;
}

function docsBySnapshotConvention(conventions: SnapshotConvention[]): Map<string, string[]> {
  const byReference = new Map<string, string[]>();
  for (const convention of conventions) {
    for (const docsRef of convention.docs) {
      const values = byReference.get(docsRef) ?? [];
      values.push(convention.id);
      byReference.set(docsRef, values);
    }
  }
  return byReference;
}

function snapshotArea(rootDir: string, areasPath: string, area: Area): SnapshotArea {
  return {
    id: area.id,
    title: area.title,
    summary: area.summary,
    surfaces: area.surfaces ?? [],
    owns: area.owns ?? [],
    storyCount: area.stories?.length ?? 0,
    behaviorCount: area.behaviors?.length ?? 0,
    checks: (area.checks ?? []).map((check) => ({ id: check.id, kind: check.kind })),
    dependsOn: area.dependsOn ?? [],
    docs: area.render.kind === AreaRenderKind.None ? [] : [areaDocsReference(area)!],
    render: area.render.kind,
    source: `${relative(rootDir, areasPath)}#${area.id}`,
  };
}

function snapshotSpec(rootDir: string, specsPath: string, spec: Spec): SnapshotSpec {
  return {
    id: spec.id,
    title: spec.title,
    summary: spec.summary,
    surfaces: spec.surfaces ?? [],
    areas: spec.areas ?? [],
    scope: spec.scope ?? [],
    ruleCount: spec.rules?.length ?? 0,
    scenarioCount: spec.scenarios?.length ?? 0,
    checks: (spec.checks ?? []).map((check) => ({ id: check.id, kind: check.kind })),
    dependsOn: spec.dependsOn ?? [],
    governedBy: spec.governedBy?.conventions ?? [],
    docs: spec.render.kind === "none" ? [] : [specDocsReference(spec)!],
    render: spec.render.kind,
    source: `${relative(rootDir, specsPath)}#${spec.id}`,
  };
}

function snapshotChange(rootDir: string, changesPath: string, change: Change, state: { events: CanonEvent[]; findings: CanonFinding[]; taskLeases: ReturnType<typeof activeTaskLeaseSummaries> }): SnapshotChange {
  const lastEvent = latestChangeEvent(change.id, state.events);
  const lastChangeLevelEvent = latestChangeLevelEvent(change.id, state.events);
  const tasks = deriveChangeTaskStates(change, state.events, { leases: state.taskLeases }).map((task): SnapshotChangeTask => ({
    ...task,
    updates: {
      areas: task.updates.areas ?? [],
      specs: task.updates.specs ?? [],
      conventions: task.updates.conventions ?? [],
      surfaces: task.updates.surfaces ?? [],
      docs: task.updates.docs ?? [],
    },
  }));
  return {
    id: change.id,
    title: change.title,
    kind: change.kind,
    summary: change.summary ?? change.intent.outcome,
    intent: change.intent,
    updates: {
      areas: change.updates?.areas ?? [],
      specs: change.updates?.specs ?? [],
      conventions: change.updates?.conventions ?? [],
      surfaces: change.updates?.surfaces ?? [],
      docs: change.updates?.docs ?? [],
    },
    scope: change.scope ?? [],
    planCount: change.plan?.length ?? 0,
    taskCount: change.tasks?.length ?? 0,
    readyTaskCount: tasks.filter((task) => task.ready).length,
    blockedTaskCount: tasks.filter((task) => task.status === ChangeWorkStatus.Blocked || task.blockedReasons.length > 0).length,
    tasks,
    checks: (change.checks ?? []).map((check) => ({ id: check.id, kind: check.kind })),
    dependsOn: change.dependsOn ?? [],
    blockedBy: change.blockedBy ?? [],
    docs: change.render.kind === ChangeRenderKind.None ? [] : [changeDocsReference(change)!],
    render: change.render.kind,
    source: `${relative(rootDir, changesPath)}#${change.id}`,
    boardColumn: changeBoardColumn(change, { lastEvent: lastChangeLevelEvent, findings: state.findings, tasks }),
    lastEvent: lastEvent ? { type: lastEvent.type, timestamp: lastEvent.timestamp, summary: lastEvent.summary } : undefined,
  };
}

function latestChangeEvent(changeId: string, events: CanonEvent[]): CanonEvent | undefined {
  return events
    .filter((event) => (event.changeIds ?? []).includes(changeId))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
}

function latestChangeLevelEvent(changeId: string, events: CanonEvent[]): CanonEvent | undefined {
  return events
    .filter((event) => (event.changeIds ?? []).includes(changeId) && !isTaskScopedChangeEvent(event))
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp))[0];
}

function isTaskScopedChangeEvent(event: CanonEvent): boolean {
  return (event.taskIds?.length ?? 0) > 0 || event.type.startsWith("task-");
}

function changeBoardColumn(change: Change, state: { lastEvent?: CanonEvent; findings: CanonFinding[]; tasks: SnapshotChangeTask[] }): SnapshotChangeBoardColumn {
  const eventColumn = state.lastEvent ? changeBoardColumnFromEvent(state.lastEvent) : undefined;
  if (eventColumn === "closed" || eventColumn === "ready" || eventColumn === "review" || eventColumn === "running") return eventColumn;
  if (changeHasBlockingFindings(change, state.findings)) return "blocked";
  if (eventColumn === "blocked") return "blocked";
  if (state.tasks.length > 0) {
    if (state.tasks.some((task) => task.status === ChangeWorkStatus.Blocked || task.blockedReasons.length > 0)) return "blocked";
    if (state.tasks.some((task) => task.status === ChangeWorkStatus.Running || task.status === ChangeWorkStatus.Claimed)) return "running";
    if (state.tasks.some((task) => task.status === ChangeWorkStatus.Review)) return "review";
    if (state.tasks.every((task) => task.status === ChangeWorkStatus.Closed) || state.tasks.some((task) => task.ready || task.status === ChangeWorkStatus.Ready)) return "ready";
  }
  return "planned";
}

function changeBoardColumnFromEvent(event: CanonEvent): SnapshotChangeBoardColumn | undefined {
  switch (event.type) {
    case "change-started":
    case "check-started":
      return "running";
    case "change-review":
      return "review";
    case "change-blocked":
    case "check-failed":
      return "blocked";
    case "change-ready":
    case "check-passed":
      return "ready";
    case "change-closed":
      return "closed";
    default:
      return undefined;
  }
}

function changeHasBlockingFindings(change: Change, findings: CanonFinding[]): boolean {
  const files = definitionTargetFiles(change.scope);
  if (files.length === 0) return false;
  return findings.some((finding) => finding.severity === FindingSeverity.Error && finding.file && (files.includes(finding.file) || matchesAnyFile([finding.file], files)));
}

function snapshotImpactSurfaces(surfaces: ImpactSurface[], areas: Area[], specs: Spec[], changes: Change[]): SnapshotImpactSurface[] {
  return surfaces.map((surface) => ({
    ...surface,
    areaIds: areas
      .filter((area) => areaLinksImpactSurface(area, surface))
      .map((area) => area.id)
      .sort(),
    specIds: specs
      .filter((spec) => specLinksImpactSurface(spec, surface))
      .map((spec) => spec.id)
      .sort(),
    changeIds: changes
      .filter((change) => changeLinksImpactSurface(change, surface))
      .map((change) => change.id)
      .sort(),
  }));
}

function areaLinksImpactSurface(area: Area, surface: ImpactSurface): boolean {
  if ((area.surfaces ?? []).includes(surface.id)) return true;
  return filesTouchImpactSurface(definitionTargetFiles(area.owns), surface);
}

function specLinksImpactSurface(spec: Spec, surface: ImpactSurface): boolean {
  if ((spec.surfaces ?? []).includes(surface.id)) return true;
  return filesTouchImpactSurface(definitionTargetFiles(spec.scope), surface);
}

function changeLinksImpactSurface(change: Change, surface: ImpactSurface): boolean {
  if ((change.updates?.surfaces ?? []).includes(surface.id)) return true;
  return filesTouchImpactSurface(definitionTargetFiles(change.scope), surface);
}

function filesTouchImpactSurface(files: string[], surface: ImpactSurface): boolean {
  if (files.length === 0) return false;
  return files.some((file) => surface.applies.includes(file) || matchesAnyFile([file], surface.applies));
}

function buildSnapshotFileCoverage(input: {
  files: string[];
  areas: SnapshotArea[];
  specs: SnapshotSpec[];
  changes: SnapshotChange[];
  conventions: SnapshotConvention[];
  impactSurfaces: SnapshotImpactSurface[];
}): Record<string, DefinitionGraphFileCoverage> {
  const coverage: Record<string, DefinitionGraphFileCoverage> = {};
  for (const file of input.files) {
    coverage[file] = {
      areas: input.areas
        .filter((area) => fileMatchesReferences(file, [...definitionTargetFiles(area.owns), ...area.docs]))
        .map((area) => area.id),
      specs: input.specs
        .filter((spec) => fileMatchesReferences(file, [...definitionTargetFiles(spec.scope), ...spec.docs]))
        .map((spec) => spec.id),
      changes: input.changes
        .filter((change) => fileMatchesReferences(file, [...definitionTargetFiles(change.scope), ...change.docs, ...change.updates.docs]))
        .map((change) => change.id),
      conventions: input.conventions
        .filter((convention) => fileMatchesReferences(file, [...convention.applies, ...convention.docs]))
        .map((convention) => convention.id),
      surfaces: input.impactSurfaces
        .filter((surface) => fileMatchesReferences(file, [...surface.applies, ...(surface.owns ?? []), ...(surface.docs ?? [])]))
        .map((surface) => surface.id),
    };
  }
  return coverage;
}

function fileMatchesReferences(file: string, references: string[]): boolean {
  const patterns = references.map(stripReferenceHash).filter((reference) => reference.length > 0);
  return patterns.length > 0 && matchesAny(file, patterns);
}

function stripReferenceHash(value: string): string {
  return value.split("#", 1)[0] ?? "";
}

function snapshotConvention(rootDir: string, conventionsPath: string, convention: Convention): SnapshotConvention {
  return {
    id: convention.id,
    title: convention.title,
    topics: convention.topics ?? [],
    applies: conventionApplies(convention),
    rule: convention.rule,
    why: convention.why,
    related: convention.related ?? [],
    impactSurfaces: convention.impactSurfaces ?? [],
    docs: convention.render.kind === ConventionRenderKind.None ? [] : [conventionDocsReference(convention)!],
    runtime: convention.runtime.kind,
    render: convention.render.kind,
    source: `${relative(rootDir, conventionsPath)}#${convention.id}`,
  };
}

function conventionApplies(convention: Convention): string[] {
  switch (convention.applies.kind) {
    case "files":
    case "symbols":
      return convention.applies.globs;
    case "imports":
      return [...(convention.applies.from ?? []), ...(convention.applies.to ?? [])];
    case "impact-surface":
      return convention.applies.surfaceIds;
    case "definitions":
      return convention.applies.definitions.flatMap((target) => (target.ids ?? ["*"]).map((id) => `${target.kind}:${id}`));
    case "project":
      return [convention.applies.describe ?? "project"];
    case "custom":
      return [convention.applies.describe];
  }
}
