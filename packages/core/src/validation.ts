import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { getAnalysisCache } from "./cache.ts";
import { DiagnosticSeverity } from "./contracts.ts";
import { loadImpactSurfaces } from "./context.ts";
import type { ContextPaths } from "./core.ts";
import type { Convention } from "./convention.ts";
import type { Area } from "./area.ts";
import type { Change } from "./change.ts";
import type { Spec } from "./spec.ts";
import type { GoverningConventionsResult } from "./convention-scope.ts";
import { resolveGoverningConventionsForFiles } from "./convention-scope.ts";
import { discoverProjectFiles, intersects, matchesAny, unique } from "./core.ts";
import { applyFindingFixes } from "./fixes.ts";
import type { FixApplicationResult, FixMode } from "./fixes.ts";
import { createProfiler } from "./profiler.ts";
import type { ProfileEntry, Profiler } from "./profiler.ts";
import { createEphemeralValidationResultCache, validationRuntimeFingerprint, validatorRunCacheKey, type ProjectFileFingerprint, type ValidationResultCache } from "./validation-result-cache.ts";
import type { Finding, Validator } from "./validator.ts";
import type { CommitGate } from "./validator.ts";
import type { ProducerStatus, ProducerSnapshot } from "./type-facts-provider.ts";
import { ProducerStatusKind } from "./type-facts-provider.ts";
import { ValidatorDomain } from "./validator-types.ts";
import {
  commitGateDiagnosticsFromValidationContext,
  commitGatesFromValidationContext,
  consumedTypedFactsFromValidationContext,
  createRuntime,
  createValidationContext,
  flushValidationContextCache,
  installContextTypeFacts,
  resolveArtifactTypeFactsProvider,
  resolveLiveTypeFactsProvider,
  resolveRunTypeFacts,
  validateFindings,
  validatorMatchesFile,
} from "./validator.ts";
import { ProjectFileLanguage } from "./language-registry.ts";
import {
  ProducerSourceKind,
  producerSourceForLanguage,
  type ProducerPolicy,
  type ProducerSource,
} from "./producer-registry.ts";

export type ValidationInput = {
  rootDir: string;
  paths: ContextPaths;
  conventions: Convention[];
  areas?: Area[];
  specs?: Spec[];
  changes?: Change[];
  validators: Validator[];
  files?: string[];
  topics?: string[];
  validatorIds?: string[];
  project?: boolean;
  fixMode?: FixMode;
  dryRun?: boolean;
  profiler?: Profiler;
  /** Escalate every `requiresProducers` skip into an error finding (nonzero exit). */
  strictProducers?: boolean;
  producerPolicy: ProducerPolicy;
  /**
   * Optional runtime-owned content fingerprints for discovered project inventory.
   * Validator target and analysis files are still byte-fingerprinted locally.
   */
  projectFileFingerprints?: ProjectFileFingerprint[];
  /**
   * Persistent caches are owned by the project runtime. Direct library callers
   * that omit this get an isolated in-memory cache for this validation call.
   */
  resultCache?: ValidationResultCache;
};

/**
 * The non-finding result of running ONE validator: did it run, skip, or error,
 * and why. Outcomes are the channel for everything that is NOT an actionable
 * issue in project code — producer skips, validator-runtime contract violations,
 * forgetful-author producer-usage. They are NEVER file-anchored; a `Finding`
 * means strictly "actionable issue in project code". Producer dependency is by
 * LANGUAGE: `producer` records the language + the generation used, so
 * a future Python/Rust producer needs no contract change.
 */
/**
 * ValidatorOutcome status as a const value-set (single source of truth) so code
 * references members (`ValidatorOutcomeStatus.Error`) instead of inlining strings.
 */
export const ValidatorOutcomeStatus = {
  Ran: "ran",
  Skipped: "skipped",
  Error: "error",
} as const;
export type ValidatorOutcomeStatus = (typeof ValidatorOutcomeStatus)[keyof typeof ValidatorOutcomeStatus];

export type ValidatorOutcome = {
  validatorId: string;
  status: ValidatorOutcomeStatus;
  reason?: string;
  /** The producer (language + generation seen) that drove a skip, when applicable. */
  producer?: { language: string; generation: number };
};

export type ValidationResult = {
  files: string[];
  validators: string[];
  validatorGraphHash: string;
  findingCount: number;
  diagnostics: string[];
  /** Code-only: every finding is an actionable issue in project code. No meta. */
  findings: Finding[];
  /** Per-validator run/skip/error outcomes (producer skips, runtime contract errors). */
  validatorOutcomes: ValidatorOutcome[];
  /**
   * The producer generation(s) actually used to compute this result:
   * language -> { kind, generation }. Invariant: the result states EXACTLY which
   * producer generation backed it, so a surface can never claim "ready" about a
   * result computed from warming/stale facts.
   */
  producerSnapshot: ProducerSnapshot;
  commitGates: CommitGate[];
  governingConventions?: GoverningConventionsResult;
  fixes?: FixApplicationResult;
  profile?: ProfileEntry[];
};

type ValidationRunResult = {
  findings: Finding[];
  outcomes: ValidatorOutcome[];
  producerSnapshot: ProducerSnapshot;
  commitGates: CommitGate[];
  diagnostics: string[];
};

export async function runValidation(input: ValidationInput): Promise<ValidationResult> {
  const profiler = input.profiler ?? createProfiler(false);
  const files = input.files ?? [];
  const selectedValidators = selectValidators(input.validators, {
    topics: input.topics ?? [],
    validatorIds: input.validatorIds ?? [],
  });
  const runtime = createRuntime(input.paths, input.conventions, {
    areas: input.areas ?? [],
    specs: input.specs ?? [],
    changes: input.changes ?? [],
  });
  const resultCache = input.resultCache ?? createEphemeralValidationResultCache();
  const findingValidationContext = {
    paths: input.paths,
    conventionIds: new Set(input.conventions.map((convention) => convention.id)),
  };
  let validation = await runValidators({
    rootDir: input.rootDir,
    paths: input.paths,
    selectedValidators,
    files,
    project: input.project ?? false,
    runtime,
    findingValidationContext,
    profiler,
    strictProducers: input.strictProducers ?? false,
    producerPolicy: input.producerPolicy,
    projectFileFingerprints: input.projectFileFingerprints,
    resultCache,
  });
  let findings = validation.findings;
  let outcomes = validation.outcomes;
  let producerSnapshot = validation.producerSnapshot;
  let commitGates = validation.commitGates;
  let fixes: FixApplicationResult | undefined;

  if (input.fixMode) {
    fixes = applyFindingFixes({
      rootDir: input.rootDir,
      findings,
      mode: input.fixMode,
      dryRun: input.dryRun ?? false,
    });

    if (!input.dryRun && fixes.diagnostics.length === 0 && fixes.appliedEdits > 0) {
      validation = await runValidators({
        rootDir: input.rootDir,
        paths: input.paths,
        selectedValidators,
        files,
        project: input.project ?? false,
        runtime,
        findingValidationContext,
        profiler,
        strictProducers: input.strictProducers ?? false,
        producerPolicy: input.producerPolicy,
        projectFileFingerprints: input.projectFileFingerprints,
        resultCache,
      });
      findings = validation.findings;
      outcomes = validation.outcomes;
      producerSnapshot = validation.producerSnapshot;
      commitGates = validation.commitGates;
    }
  }
  const governingConventions = resolveGoverningConventionsForFiles({
    files,
    conventions: input.conventions,
    impactSurfaces: loadImpactSurfaces(input.paths).surfaces,
    includeConventionIds: commitGates.flatMap((gate) => gate.conventionIds ?? []),
  });

  return {
    files,
    validators: selectedValidators.map((validator) => validator.id),
    validatorGraphHash: validatorGraphHash(selectedValidators),
    findingCount: findings.length,
    diagnostics: validation.diagnostics,
    findings,
    validatorOutcomes: outcomes,
    producerSnapshot,
    commitGates,
    governingConventions,
    fixes,
    profile: profiler.enabled ? profiler.entries() : undefined,
  };
}

export function validatorGraphHash(validators: Validator[]): string {
  const hash = createHash("sha256");
  for (const validator of [...validators].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(
      JSON.stringify({
        id: validator.id,
        topics: validator.topics,
        appliesScopes: validator.appliesScopes,
        domain: validator.domain,
        analysisGlobs: validator.analysisGlobs,
        severity: validator.severity,
        scope: validator.scope,
        facts: validator.facts,
        conventionIds: validator.conventionIds,
        docs: validator.docs,
        summary: validator.summary,
        visuals: validator.visuals,
      }),
    );
    hash.update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
}

export function selectValidators(validators: Validator[], query: { topics: string[]; validatorIds: string[] }): Validator[] {
  if (query.validatorIds.length === 0 && query.topics.length === 0) return validators;
  return validators.filter(
    (validator) =>
      query.validatorIds.includes(validator.id) ||
      intersects(validator.topics, query.topics) ||
      intersects(validator.conventionIds ?? [], query.validatorIds),
  );
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      (left.column ?? 0) - (right.column ?? 0) ||
      left.validatorId.localeCompare(right.validatorId) ||
      left.message.localeCompare(right.message),
  );
}

function typeFactsProviderForPolicy(rootDir: string, policy: ProducerPolicy, language: string) {
  const source = producerSourceForLanguage(policy, language);
  if (source.kind === ProducerSourceKind.Artifact) return resolveArtifactTypeFactsProvider(rootDir, language, source.id);
  if (source.kind === ProducerSourceKind.Live) return resolveLiveTypeFactsProvider(rootDir, language, source.worker);
  return {
    language,
    status: () => ({
      language,
      kind: ProducerStatusKind.NotImplemented,
      ...(source.detail ? { detail: source.detail } : {}),
    }),
    factGeneration: () => undefined,
    resolveTypes: () => Promise.resolve(new Map()),
  };
}

function nonQueryProducerStatuses(policy: ProducerPolicy, queriedLanguage: string): ProducerStatus[] {
  return Object.entries(policy.sources)
    .filter(([language]) => language !== queriedLanguage)
    .map(([language, source]) => statusForNonQuerySource(language, source));
}

function statusForNonQuerySource(language: string, source: ProducerSource | undefined): ProducerStatus {
  if (!source || source.kind === ProducerSourceKind.NotImplemented) {
    return {
      language,
      kind: ProducerStatusKind.NotImplemented,
      ...(source?.detail ? { detail: source.detail } : {}),
    };
  }
  return {
    language,
    kind: ProducerStatusKind.NotImplemented,
    detail: `${language} producer ${source.kind} is configured in this policy but was not queried by this validation run.`,
  };
}

async function runValidators(params: {
  rootDir: string;
  paths: ContextPaths;
  selectedValidators: Validator[];
  files: string[];
  project: boolean;
  runtime: ReturnType<typeof createRuntime>;
  findingValidationContext: {
    paths: ContextPaths;
    conventionIds: Set<string>;
  };
  profiler: Profiler;
  strictProducers: boolean;
  producerPolicy: ProducerPolicy;
  projectFileFingerprints?: ProjectFileFingerprint[];
  resultCache: ValidationResultCache;
}): Promise<ValidationRunResult> {
  const findings: Finding[] = [];
  const outcomes: ValidatorOutcome[] = [];
  const commitGates: CommitGate[] = [];
  const projectDiscovery = params.profiler.measure("discover.project", () => discoverProjectFiles(params.paths));
  if (projectDiscovery.failed) {
    return {
      findings,
      outcomes,
      producerSnapshot: {},
      commitGates,
      diagnostics: projectDiscovery.diagnostics,
    };
  }
  const projectFiles = projectDiscovery.files;
  const cache = getAnalysisCache(params.paths);
  const resultCache = params.resultCache;
  const runtimeFingerprint = validationRuntimeFingerprint({
    conventions: params.runtime.conventions.all,
    definitions: params.runtime.definitions.all(),
    impactSurfaces: loadImpactSurfaces(params.paths).surfaces,
  });

  for (const file of params.files) {
    if (!existsSync(path.join(params.rootDir, file))) {
      findings.push({
        validatorId: "file-exists",
        severity: "error",
        file,
        line: 1,
        message: "File does not exist.",
        fix: {
          safety: "manual",
          description: "Create the file or remove it from the validation target set.",
        },
      });
      continue;
    }
  }

  // Build each selected validator's context up front so we can collect the UNION
  // of comparison sites across ALL contexts and pre-warm the type-facts seam
  // ONCE per run. Resolving per-validator inside the Promise.all fired N
  // concurrent resolveTypes RPCs over largely the same sites, racing the cold
  // watch build. One batch, one shared map.
  type ValidatorJob =
    | {
        validator: Validator;
        ctx: ReturnType<typeof createValidationContext>;
        targetFiles: string[];
        analysisFiles: string[];
      }
    | { validator: Validator; ctx: null; targetFiles: string[]; analysisFiles: string[] };
  const jobs: ValidatorJob[] = params.selectedValidators.map((validator) => {
    const targetFiles = targetFilesForValidator(validator, {
      rootDir: params.rootDir,
      files: params.files,
      project: params.project,
      projectFiles,
    });
    if (targetFiles.length === 0 && shouldSkipEmptyTargetValidator(validator, { project: params.project, files: params.files, runtime: params.runtime })) {
      return { validator, ctx: null, targetFiles, analysisFiles: [] };
    }
    const analysisFiles = analysisFilesForValidator(validator, { projectFiles, targetFiles });
    const ctx = createValidationContext({
      rootDir: params.rootDir,
      paths: params.paths,
      files: projectFiles,
      targetFiles,
      analysisFiles,
      project: params.project,
      validator,
      cache,
      profiler: params.profiler,
    });
    return { validator, ctx, targetFiles, analysisFiles };
  });

  // Single shared pre-warm: resolve the union of every context's comparison
  // sites one time, then install the same map + producer statuses into each
  // context for synchronous `ctx.typed.literal()` / `ctx.typed.producerStatus()`
  // reads. If pre-warm fails before a provider can report status, synthesize a
  // crashed TypeScript producer so required validators skip loudly.
  const activeContexts = jobs.map((job) => job.ctx).filter((ctx): ctx is NonNullable<typeof ctx> => ctx !== null);
  let sharedTypeFacts: Awaited<ReturnType<typeof resolveRunTypeFacts>>;
  try {
    const typeFactsProvider = typeFactsProviderForPolicy(params.rootDir, params.producerPolicy, ProjectFileLanguage.TypeScript);
    const policyStatuses = nonQueryProducerStatuses(params.producerPolicy, typeFactsProvider.language);
    sharedTypeFacts = await params.profiler.measureAsync("prewarm.typeFacts", () =>
      resolveRunTypeFacts(activeContexts, typeFactsProvider, policyStatuses),
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.warn(`[opencanon] type-facts pre-warm failed; typescript producer status is crashed: ${detail}`);
    sharedTypeFacts = {
      map: new Map(),
      statuses: [{ language: "typescript", kind: ProducerStatusKind.Crashed, detail }],
      factGenerations: { typescript: undefined },
    };
  }
  for (const ctx of activeContexts) installContextTypeFacts(ctx, sharedTypeFacts.map, sharedTypeFacts.statuses);

  // Parse diagnostics: a file the extractor could not fully parse must not validate
  // as silently clean. Collect error-severity parse diagnostics across contexts
  // (deduped by file:line:code) and surface them on the run's diagnostics channel —
  // the CLI prints them and exits non-zero, so a malformed file is never "0 findings".
  const parseDiagnostics = new Map<string, string>();
  for (const ctx of activeContexts) {
    for (const diagnostic of ctx.facts.diagnostics()) {
      if (diagnostic.severity !== DiagnosticSeverity.Error) continue;
      parseDiagnostics.set(`${diagnostic.file}:${diagnostic.line}:${diagnostic.code ?? ""}`, `${diagnostic.file}:${diagnostic.line} ${diagnostic.message}`);
    }
  }

  const statusFor = (language: string): ProducerStatus =>
    sharedTypeFacts.statuses.find((s) => s.language === language) ?? { language, kind: "not-implemented" as const };

  /** Required producer that is not `ready`, for the skip outcome; undefined when all met. */
  const unmetProducer = (validator: Validator): ProducerStatus | undefined => {
    for (const language of validator.requiresProducers) {
      const status = statusFor(language);
      if (status.kind !== ProducerStatusKind.Ready) return status;
    }
    return undefined;
  };

  // The producer snapshot binds this result to EXACTLY the generation(s) used.
  // `kind` comes from the authoritative status captured
  // AFTER the run's resolveTypes (so a surface cannot claim "ready" about facts
  // from a warming/stale producer). `generation` comes from `factGenerations` —
  // the generation the facts were ACTUALLY computed from, carried atomically by
  // the resolveTypes response — NOT from `status().generation`, which a racing
  // `status` event for a newer generation could have already advanced past the
  // facts this run used. Fall back to the status generation only when no facts
  // were resolved (factGeneration undefined): with zero facts there is no
  // fact-generation to bind, so reporting the ready producer's current generation
  // is both safe (no result depends on a fact generation) and more informative
  // than 0. When facts DO exist, factGeneration (carried atomically by the RPC
  // response) is used, so the snapshot can never claim a generation newer than them.
  const producerSnapshot: ProducerSnapshot = {};
  for (const status of sharedTypeFacts.statuses) {
    const factGeneration = sharedTypeFacts.factGenerations[status.language];
    producerSnapshot[status.language] = {
      kind: status.kind,
      generation: factGeneration ?? status.generation ?? 0,
    };
  }

  const validatorResults = await Promise.all(
    jobs.map((job) =>
      params.profiler.measureAsync(`validator.${job.validator.id}`, async () => {
        const validator = job.validator;
        if (job.ctx === null) return { findings: [], commitGates: [], outcomes: [] as ValidatorOutcome[] };
        const ctx = job.ctx;
        // Producer gate: a validator that requires a non-`ready` producer SKIPS.
        // This is NOT a finding — it is a `validatorOutcome` (never file-anchored).
        const unmet = unmetProducer(validator);
        if (unmet) {
          const detail = unmet.detail ? ` (${unmet.detail})` : "";
          return {
            findings: [] as Finding[],
            commitGates: [] as CommitGate[],
            outcomes: [
              {
                validatorId: validator.id,
                status: "skipped" as const,
                reason: `${unmet.language} producer ${unmet.kind}${detail}`,
                producer: { language: unmet.language, generation: unmet.generation ?? 0 },
              },
            ],
          };
        }
        // Per-validator error isolation: a validator that throws/rejects must NOT
        // abort the whole run (which would skip cache flush and surface as an
        // uncaught runtime /api/validate failure). Map the throw to an `error`
        // outcome — the channel that exists for exactly this — and keep going.
        const cacheKey = validatorRunCacheKey({
          rootDir: params.rootDir,
          paths: params.paths,
          projectFiles,
          projectFileFingerprints: params.projectFileFingerprints,
          targetFiles: job.targetFiles,
          analysisFiles: job.analysisFiles,
          project: params.project,
          strictProducers: params.strictProducers,
          validator,
          producerSnapshot,
          runtimeFingerprint,
        });
        const cached = resultCache.get(cacheKey);
        if (cached) {
          flushValidationContextCache(ctx);
          return cached;
        }
        try {
          const findings = (await validator.validate({ ctx, runtime: params.runtime })).map((finding) => attachFindingReferences(finding, validator));
          const commitGates = commitGatesFromValidationContext(ctx).map((gate) => attachCommitGateReferences(gate, validator));
          const commitGateDiagnostics = commitGateDiagnosticsFromValidationContext(ctx);
          // Validator-runtime contract violations: finding-shape errors or invalid
          // commit gates. These are NOT code findings — they are `error` outcomes.
          const runtimeErrors = [...validateFindings(validator, findings, params.findingValidationContext), ...commitGateDiagnostics];
          // (forgetful-author producer dependency): consumed producer-resolved type
          // facts for a non-ready, undeclared language. A `skipped` outcome (loud,
          // not silent) — advisory by default, an `error` outcome under strict.
          const declared = new Set(validator.requiresProducers);
          const producerUsageReasons: string[] = [];
          for (const language of consumedTypedFactsFromValidationContext(ctx)) {
            if (declared.has(language)) continue;
            const status = statusFor(language);
            if (status.kind === ProducerStatusKind.Ready) continue;
            producerUsageReasons.push(
              `${validator.id} used typed facts for ${language} but its producer is ${status.kind} and ${validator.id} does not declare requiresProducers: ['${language}'] — results may be incomplete. Add the declaration to skip loudly.`,
            );
          }
          const outcomes: ValidatorOutcome[] = [];
          for (const reason of runtimeErrors) {
            outcomes.push({ validatorId: validator.id, status: "error", reason });
          }
          for (const reason of producerUsageReasons) {
            outcomes.push({ validatorId: validator.id, status: params.strictProducers ? "error" : "skipped", reason });
          }
          if (outcomes.length === 0) outcomes.push({ validatorId: validator.id, status: "ran" });
          const result = { findings, commitGates, outcomes };
          if (outcomes.length === 1 && outcomes[0]?.status === ValidatorOutcomeStatus.Ran) resultCache.set(cacheKey, result);
          return result;
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return {
            findings: [] as Finding[],
            commitGates: [] as CommitGate[],
            outcomes: [{ validatorId: validator.id, status: "error" as const, reason: `validator threw: ${reason}` }],
          };
        } finally {
          flushValidationContextCache(ctx);
        }
      }),
    ),
  );

  findings.push(...validatorResults.flatMap((result) => result.findings));
  commitGates.push(...validatorResults.flatMap((result) => result.commitGates));
  outcomes.push(...validatorResults.flatMap((result) => result.outcomes));
  cache.flush();
  resultCache.flush();

  return {
    findings: sortFindings(findings),
    outcomes: sortOutcomes(outcomes),
    producerSnapshot,
    commitGates: sortCommitGates(commitGates),
    diagnostics: [...projectDiscovery.diagnostics, ...parseDiagnostics.values()],
  };
}

function sortOutcomes(outcomes: ValidatorOutcome[]): ValidatorOutcome[] {
  return [...outcomes].sort(
    (left, right) =>
      left.validatorId.localeCompare(right.validatorId) ||
      left.status.localeCompare(right.status) ||
      (left.reason ?? "").localeCompare(right.reason ?? ""),
  );
}

function analysisFilesForValidator(validator: Validator, query: { projectFiles: string[]; targetFiles: string[] }): string[] {
  if (validator.analysisGlobs.length === 0) return query.targetFiles;
  const analysisFiles = query.projectFiles.filter((file) => matchesAny(file, validator.analysisGlobs));
  return unique([...query.targetFiles, ...analysisFiles]);
}

function attachFindingReferences(finding: Finding, validator: Validator): Finding {
  return {
    ...finding,
    conventionIds: unique([...(validator.conventionIds ?? []), ...(finding.conventionIds ?? [])]),
    docs: unique([...(validator.docs ?? []), ...(finding.docs ?? [])]),
  };
}

function attachCommitGateReferences(gate: CommitGate, validator: Validator): CommitGate {
  return {
    ...gate,
    conventionIds: unique([...(validator.conventionIds ?? []), ...(gate.conventionIds ?? [])]),
  };
}

function sortCommitGates(gates: CommitGate[]): CommitGate[] {
  return [...gates].sort(
    (left, right) =>
      left.id.localeCompare(right.id) ||
      left.validatorId.localeCompare(right.validatorId) ||
      (left.file ?? "").localeCompare(right.file ?? "") ||
      (left.line ?? 0) - (right.line ?? 0),
  );
}

function targetFilesForValidator(
  validator: Validator,
  query: {
    rootDir: string;
    files: string[];
    project: boolean;
    projectFiles: string[];
  },
): string[] {
  if (query.project) {
    if (validator.appliesScopes.length === 0) return validatorTargetsFiles(validator) ? query.projectFiles : [];
    return query.projectFiles.filter((file) => validatorMatchesFile(validator, file));
  }
  const existingFiles = query.files.filter((file) => query.projectFiles.includes(file) || existsSync(path.join(query.rootDir, file)));
  if (validator.appliesScopes.length === 0) return validatorTargetsFiles(validator) ? existingFiles : [];
  return existingFiles.filter((file) => validatorMatchesFile(validator, file));
}

function shouldSkipEmptyTargetValidator(validator: Validator, query: { project: boolean; files: string[]; runtime: ValidatorRuntimeLike }): boolean {
  if (!validatorTargetsFiles(validator) && query.project) return false;
  if (!query.project && query.files.length === 0) return true;
  if (validator.domain === ValidatorDomain.Definition) return !targetsDefinitionSource(query.files, query.runtime);
  if (!validatorTargetsFiles(validator)) return true;
  return validatorTargetsFiles(validator);
}

function validatorTargetsFiles(validator: Validator): boolean {
  return validator.domain === ValidatorDomain.File || validator.domain === ValidatorDomain.ImportEdge;
}

type ValidatorRuntimeLike = Pick<ReturnType<typeof createRuntime>, "definitions">;

function targetsDefinitionSource(files: string[], runtime: ValidatorRuntimeLike): boolean {
  const definitionSources = new Set(
    runtime.definitions
      .all()
      .map((definition) => definition.source?.split("#", 1)[0])
      .filter((source): source is string => Boolean(source)),
  );
  return files.some((file) => definitionSources.has(file));
}
