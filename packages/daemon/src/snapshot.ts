import path from "node:path";
import { createHash } from "node:crypto";
import {
  createOpenCanonDiagnostic,
  createValidationContext,
  discoverProjectFiles,
  getGitFileDiff,
  getGitFileHistory,
  intersects,
  loadProjectContext,
  matchesAny,
  matchesAnyFile,
  relative,
  resolveDocsReferences,
  runValidation,
  type CanonFinding,
  type DaemonHealth,
  type DaemonState,
  type Decision,
  type DocSnippet,
  type FileFacts,
  type FactKind,
  type ImpactSurface,
  type RepoGraph,
  type Validator,
} from "@opencanon/core";
import type { Engine } from "@opencanon/engine";
import { daemonSchemaVersion } from "./runtime.ts";
import type { DaemonStore } from "./state.ts";

const allFactKinds: FactKind[] = ["imports", "exports", "symbols", "calls", "literals", "comments"];

const FindingSeverity = {
  Error: "error",
} as const;

const SnapshotFindingKind = {
  Violation: "violation",
  Warning: "warning",
} as const;

const SnapshotValidator = {
  Id: "daemon-snapshot",
  Severity: "warning",
} as const;

export type DaemonSnapshot = {
  health: DaemonHealth;
  state: DaemonState;
  files: string[];
  decisions: Decision[];
  docs: DocSnippet[];
  graph: RepoGraph;
  facts: CodeFileFacts[];
  findings: CanonFinding[];
  impactSurfaces: ImpactSurface[];
  validators: Array<{
    id: string;
    severity: Validator["severity"];
    scope: Validator["scope"];
    facts: Validator["facts"];
    topics: string[];
    appliesScopes: string[][];
    decisionIds: string[];
    docs: string[];
    summary?: string;
    visuals: Array<{ kind: "tree"; title?: string; definition: unknown }>;
  }>;
};

type CodeFileFacts = Pick<FileFacts, "path" | "imports" | "exports" | "symbols">;
type SnapshotValidator = DaemonSnapshot["validators"][number];

export type RelatedCanonQuery = {
  files?: string[];
  topics?: string[];
  decisionIds?: string[];
  validatorIds?: string[];
  findingIds?: string[];
};

export type RelatedCanon = {
  root: string;
  query: {
    files: string[];
    topics: string[];
    decisions: string[];
    validators: string[];
    findings: string[];
  };
  matchedTopics: string[];
  docs: DocSnippet[];
  decisions: Array<Decision & { source: string }>;
  validators: Array<{
    id: string;
    topics: string[];
    applies: string[];
    severity: SnapshotValidator["severity"];
    scope: SnapshotValidator["scope"];
    facts: SnapshotValidator["facts"];
    decisionIds: string[];
    docs: string[];
    summary?: string;
  }>;
  findings: CanonFinding[];
  impactSurfaces: ImpactSurface[];
};

export async function buildDaemonSnapshot(input: { cwd: string; engine: Engine; store: DaemonStore }): Promise<DaemonSnapshot> {
  const project = await loadProjectContext(input.cwd);
  const discovery = discoverProjectFiles(project.paths);
  if (discovery.failed) {
    throw new Error(discovery.diagnostics.join("\n"));
  }

  const scan = input.store.scanAndDiff(discovery.files);
  const facts = input.store.project.extractFacts({
    files: scan.files
      .filter((file) => isOxcSourceFile(file.path))
      .map((file) => ({
        path: file.path,
        contentHash: file.contentHash,
        language: languageForFile(file.path),
      })),
    facts: allFactKinds,
    parserVersion: "oxc-0.128.0",
  });
  const factDiagnostics = [
    ...facts.diagnostics,
    ...facts.files.flatMap((file) => file.diagnostics.map((diagnostic) => ({ ...diagnostic, message: `${file.path}: ${diagnostic.message}` }))),
  ];
  if (factDiagnostics.some((diagnostic) => diagnostic.severity === FindingSeverity.Error)) {
    throw new Error(factDiagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }

  const nativeGraph = input.store.project.buildRepoGraph({
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
    ...nativeGraph,
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
    decisions: project.decisions,
    validators: project.validators,
    project: true,
  });

  const health: DaemonHealth = {
    status: validation.diagnostics.length > 0 ? "failed" : "ready",
    schemaVersion: daemonSchemaVersion,
    engine: input.engine.version(),
    watcher: input.store.project.status().watcher,
    startedAt: new Date().toISOString(),
  };
  const validatorById = new Map(project.validators.map((validator) => [validator.id, validator]));
  const decisionIdsByValidator = decisionsByValidator(project.decisions);
  const decisionDocsByReference = docsByDecision(project.decisions);
  const findingIdCounts = new Map<string, number>();
  const findings = validation.findings.map((finding): CanonFinding => {
    const docs = finding.docs ?? [];
    const decisionIds = unique([
      ...(validatorById.get(finding.validatorId)?.decisionIds ?? []),
      ...(decisionIdsByValidator.get(finding.validatorId) ?? []),
      ...(finding.decisionIds ?? []),
    ]);
    const baseId = findingSnapshotId({ ...finding, docs, decisionIds });
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
      decisionIds,
      fix: finding.fix
        ? {
            type: finding.fix.safety === "safe" ? "safe" : finding.fix.safety === "suggested" ? "unsafe" : "manual",
            description: finding.fix.description,
          }
        : undefined,
    };
  });

  input.store.writeSnapshot({ health, files: discovery.files, graph, findings });
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
    },
    files: discovery.files,
    decisions: project.decisions,
    docs: resolveDocsReferences(project.paths, [...decisionDocsByReference.keys()], decisionDocsByReference),
    graph,
    facts: facts.files.map((file) => ({
      path: file.path,
      imports: file.imports,
      exports: file.exports,
      symbols: file.symbols,
    })),
    findings,
    impactSurfaces: project.impactSurfaces,
    validators: project.validators.map((validator) => ({
      id: validator.id,
      severity: validator.severity,
      scope: validator.scope,
      facts: validator.facts,
      topics: validator.topics,
      appliesScopes: validator.appliesScopes,
      decisionIds: validator.decisionIds,
      docs: validator.docs,
      summary: validator.summary,
      visuals: validator.visuals.map((visual) => ({ kind: visual.kind, title: visual.title, definition: visual.definition })),
    })),
  };
}

export function buildRelatedCanon(input: { rootDir: string; paths: { decisionsPath: string; rootDir: string }; snapshot: DaemonSnapshot; query: RelatedCanonQuery }): RelatedCanon {
  const files = unique(input.query.files ?? []);
  const topics = new Set(input.query.topics ?? []);
  const decisionIds = new Set(input.query.decisionIds ?? []);
  const validatorIds = new Set(input.query.validatorIds ?? []);
  const findingIds = new Set(input.query.findingIds ?? []);
  const docsRefs = new Set<string>();
  const decisionDocsByReference = docsByDecision(input.snapshot.decisions);

  const findings = input.snapshot.findings.filter((finding) => {
    const matched =
      findingIds.has(finding.id) ||
      (finding.file ? files.includes(finding.file) : false) ||
      (finding.validatorId ? validatorIds.has(finding.validatorId) : false) ||
      intersects(finding.decisionIds ?? [], [...decisionIds]);
    if (matched) collectFindingContext(finding, { files, validatorIds, decisionIds, docsRefs });
    return matched;
  });

  const validators = selectRelatedValidators(input.snapshot.validators, { files, topics, decisionIds, validatorIds });
  for (const validator of validators) collectValidatorContext(validator, { topics, decisionIds, docsRefs });

  for (const finding of findings) {
    if (finding.validatorId) validatorIds.add(finding.validatorId);
  }

  const validatorsWithFindings = selectRelatedValidators(input.snapshot.validators, { files, topics, decisionIds, validatorIds });
  for (const validator of validatorsWithFindings) collectValidatorContext(validator, { topics, decisionIds, docsRefs });

  const decisions = input.snapshot.decisions.filter(
    (decision) =>
      decisionIds.has(decision.id) ||
      intersects(decision.topics, [...topics]) ||
      matchesAnyFile(files, decision.applies) ||
      docsRefs.has(sourceRef(input.paths.rootDir, input.paths.decisionsPath, decision.id)),
  );
  const impactSurfaces = input.snapshot.impactSurfaces.filter(
    (surface) =>
      intersects(surface.decisionIds ?? [], [...decisionIds]) ||
      intersects(surface.risks ?? [], [...topics]) ||
      intersects(files, surface.applies) ||
      matchesAnyFile(files, surface.applies),
  );
  for (const surface of impactSurfaces) {
    for (const decisionId of surface.decisionIds ?? []) decisionIds.add(decisionId);
    for (const docsRef of surface.docs ?? []) docsRefs.add(docsRef);
    for (const risk of surface.risks ?? []) topics.add(risk);
  }
  for (const decision of decisions) {
    for (const topic of decision.topics) topics.add(topic);
    for (const validatorId of decision.validatorIds ?? []) validatorIds.add(validatorId);
    for (const docsRef of decision.docs ?? []) docsRefs.add(docsRef);
  }

  const finalValidators = selectRelatedValidators(input.snapshot.validators, { files, topics, decisionIds, validatorIds });
  for (const validator of finalValidators) collectValidatorContext(validator, { topics, decisionIds, docsRefs });

  const matchedTopics = unique([
    ...decisions.flatMap((decision) => decision.topics),
    ...finalValidators.flatMap((validator) => validator.topics),
  ]).sort();

  return {
    root: input.rootDir,
    query: {
      files,
      topics: input.query.topics ?? [],
      decisions: input.query.decisionIds ?? [],
      validators: input.query.validatorIds ?? [],
      findings: input.query.findingIds ?? [],
    },
    matchedTopics,
    docs: resolveDocsReferences(input.paths, [...docsRefs], decisionDocsByReference),
    decisions: decisions.map((decision) => ({ ...decision, source: sourceRef(input.paths.rootDir, input.paths.decisionsPath, decision.id) })),
    validators: finalValidators.map((validator) => ({
      id: validator.id,
      topics: validator.topics,
      applies: formatAppliesScopes(validator.appliesScopes),
      severity: validator.severity,
      scope: validator.scope,
      facts: validator.facts,
      decisionIds: validator.decisionIds,
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

export function daemonSnapshotFailure(error: unknown) {
  return {
    ok: false as const,
    diagnostics: [
      createOpenCanonDiagnostic({
        code: "invalid-daemon-response",
        message: error instanceof Error ? error.message : String(error),
      }),
    ],
  };
}

function languageForFile(file: string) {
  if (file.endsWith(".tsx")) return "tsx" as const;
  if (file.endsWith(".mts") || file.endsWith(".cts")) return "typescript" as const;
  if (file.endsWith(".ts")) return "typescript" as const;
  if (file.endsWith(".jsx")) return "jsx" as const;
  if (file.endsWith(".mjs") || file.endsWith(".cjs")) return "javascript" as const;
  if (file.endsWith(".js")) return "javascript" as const;
  if (file.endsWith(".json")) return "json" as const;
  return "markdown" as const;
}

function isOxcSourceFile(file: string) {
  return [".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".mts", ".cts"].some((extension) => file.endsWith(extension));
}

function selectRelatedValidators(
  validators: SnapshotValidator[],
  query: { files: string[]; topics: Set<string>; decisionIds: Set<string>; validatorIds: Set<string> },
): SnapshotValidator[] {
  return validators.filter(
    (validator) =>
      query.validatorIds.has(validator.id) ||
      intersects(validator.topics, [...query.topics]) ||
      intersects(validator.decisionIds, [...query.decisionIds]) ||
      validatorMatchesAnyFileMetadata(validator, query.files),
  );
}

function collectFindingContext(
  finding: CanonFinding,
  output: { files: string[]; validatorIds: Set<string>; decisionIds: Set<string>; docsRefs: Set<string> },
): void {
  if (finding.file && !output.files.includes(finding.file)) output.files.push(finding.file);
  if (finding.validatorId) output.validatorIds.add(finding.validatorId);
  for (const decisionId of finding.decisionIds ?? []) output.decisionIds.add(decisionId);
  for (const docsRef of finding.docs ?? []) output.docsRefs.add(docsRef);
}

function collectValidatorContext(
  validator: SnapshotValidator,
  output: { topics: Set<string>; decisionIds: Set<string>; docsRefs: Set<string> },
): void {
  for (const topic of validator.topics) output.topics.add(topic);
  for (const decisionId of validator.decisionIds) output.decisionIds.add(decisionId);
  for (const docsRef of validator.docs) output.docsRefs.add(docsRef);
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

function sourceRef(rootDir: string, filePath: string, id: string): string {
  return `${relative(rootDir, filePath)}#${id}`;
}

export function findingSnapshotId(finding: Pick<CanonFinding, "validatorId" | "file" | "line" | "column" | "severity" | "message" | "docs" | "decisionIds">): string {
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
        decisionIds: finding.decisionIds ?? [],
      }),
    )
    .digest("hex")
    .slice(0, 16);
  return `${validatorId}:${hash}`;
}

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

function decisionsByValidator(decisions: Decision[]): Map<string, string[]> {
  const byValidator = new Map<string, string[]>();
  for (const decision of decisions) {
    for (const validatorId of decision.validatorIds ?? []) {
      const values = byValidator.get(validatorId) ?? [];
      values.push(decision.id);
      byValidator.set(validatorId, values);
    }
  }
  return byValidator;
}

function docsByDecision(decisions: Decision[]): Map<string, string[]> {
  const byReference = new Map<string, string[]>();
  for (const decision of decisions) {
    for (const docsRef of decision.docs ?? []) {
      const values = byReference.get(docsRef) ?? [];
      values.push(decision.id);
      byReference.set(docsRef, values);
    }
  }
  return byReference;
}
