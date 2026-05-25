import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import { getAnalysisCache } from "./cache.ts";
import type { ContextPaths, Decision } from "./core.ts";
import { discoverProjectFiles, intersects, matchesAny, relative, unique } from "./core.ts";
import { applyFindingFixes } from "./fixes.ts";
import type { FixApplicationResult, FixMode } from "./fixes.ts";
import { createProfiler } from "./profiler.ts";
import type { ProfileEntry, Profiler } from "./profiler.ts";
import type { Finding, Validator } from "./validator.ts";
import type { CommitGate } from "./validator.ts";
import {
  commitGateDiagnosticsFromValidationContext,
  commitGatesFromValidationContext,
  createRuntime,
  createValidationContext,
  flushValidationContextCache,
  validateFindings,
  validatorMatchesFile,
} from "./validator.ts";

export type ValidationInput = {
  rootDir: string;
  paths: ContextPaths;
  decisions: Decision[];
  validators: Validator[];
  files?: string[];
  topics?: string[];
  validatorIds?: string[];
  project?: boolean;
  fixMode?: FixMode;
  dryRun?: boolean;
  profiler?: Profiler;
};

export type ValidationResult = {
  files: string[];
  validators: string[];
  validatorGraphHash: string;
  findingCount: number;
  diagnostics: string[];
  findings: Finding[];
  commitGates: CommitGate[];
  fixes?: FixApplicationResult;
  profile?: ProfileEntry[];
};

type ValidationRunResult = {
  findings: Finding[];
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
  const runtime = createRuntime(input.paths, input.decisions);
  const findingValidationContext = {
    paths: input.paths,
    decisionIds: new Set(input.decisions.map((decision) => decision.id)),
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
  });
  let findings = validation.findings;
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
      });
      findings = validation.findings;
      commitGates = validation.commitGates;
    }
  }

  return {
    files,
    validators: selectedValidators.map((validator) => validator.id),
    validatorGraphHash: validatorGraphHash(selectedValidators),
    findingCount: findings.length,
    diagnostics: validation.diagnostics,
    findings,
    commitGates,
    fixes,
    profile: profiler.enabled ? profiler.entries() : undefined,
  };
}

function validatorGraphHash(validators: Validator[]): string {
  const hash = createHash("sha256");
  for (const validator of [...validators].sort((left, right) => left.id.localeCompare(right.id))) {
    hash.update(
      JSON.stringify({
        id: validator.id,
        topics: validator.topics,
        appliesScopes: validator.appliesScopes,
        analysisGlobs: validator.analysisGlobs,
        severity: validator.severity,
        scope: validator.scope,
        facts: validator.facts,
        decisionIds: validator.decisionIds,
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
      intersects(validator.decisionIds ?? [], query.validatorIds),
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

async function runValidators(params: {
  rootDir: string;
  paths: ContextPaths;
  selectedValidators: Validator[];
  files: string[];
  project: boolean;
  runtime: ReturnType<typeof createRuntime>;
  findingValidationContext: {
    paths: ContextPaths;
    decisionIds: Set<string>;
  };
  profiler: Profiler;
}): Promise<ValidationRunResult> {
  const findings: Finding[] = [];
  const commitGates: CommitGate[] = [];
  const projectDiscovery = params.profiler.measure("discover.project", () => discoverProjectFiles(params.paths));
  if (projectDiscovery.failed) {
    return {
      findings,
      commitGates,
      diagnostics: projectDiscovery.diagnostics,
    };
  }
  const projectFiles = projectDiscovery.files;
  const cache = getAnalysisCache(params.paths);

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

  const validatorResults = await Promise.all(
    params.selectedValidators.map((validator) =>
      params.profiler.measureAsync(`validator.${validator.id}`, async () => {
        const targetFiles = targetFilesForValidator(validator, {
          rootDir: params.rootDir,
          files: params.files,
          project: params.project,
          projectFiles,
        });
        if (targetFiles.length === 0 && (params.project || params.files.length > 0)) return { findings: [], commitGates: [] };
        const ctx = createValidationContext({
          rootDir: params.rootDir,
          paths: params.paths,
          files: projectFiles,
          targetFiles,
          analysisFiles: analysisFilesForValidator(validator, { projectFiles, targetFiles }),
          project: params.project,
          validator,
          cache,
          profiler: params.profiler,
        });
        const findings = (await validator.validate({ ctx, runtime: params.runtime })).map((finding) => attachFindingReferences(finding, validator));
        const commitGates = commitGatesFromValidationContext(ctx).map((gate) => attachCommitGateReferences(gate, validator));
        const commitGateDiagnostics = commitGateDiagnosticsFromValidationContext(ctx);
        flushValidationContextCache(ctx);
        return {
          findings: [
            ...findings,
            ...[...validateFindings(validator, findings, params.findingValidationContext), ...commitGateDiagnostics].map((diagnostic) => ({
              validatorId: "validator-runtime",
              severity: "error" as const,
              file: relative(params.rootDir, params.paths.validatorsPath),
              line: 1,
              message: diagnostic,
              fix: {
                safety: "manual" as const,
                description: "Fix the validator implementation so findings match the runtime contract.",
              },
            })),
          ],
          commitGates,
        };
      }),
    ),
  );

  findings.push(...validatorResults.flatMap((result) => result.findings));
  commitGates.push(...validatorResults.flatMap((result) => result.commitGates));
  cache.flush();

  return {
    findings: sortFindings(findings),
    commitGates: sortCommitGates(commitGates),
    diagnostics: projectDiscovery.diagnostics,
  };
}

function analysisFilesForValidator(validator: Validator, query: { projectFiles: string[]; targetFiles: string[] }): string[] {
  if (validator.analysisGlobs.length === 0) return query.targetFiles;
  const analysisFiles = query.projectFiles.filter((file) => matchesAny(file, validator.analysisGlobs));
  return unique([...query.targetFiles, ...analysisFiles]);
}

function attachFindingReferences(finding: Finding, validator: Validator): Finding {
  return {
    ...finding,
    decisionIds: unique([...(validator.decisionIds ?? []), ...(finding.decisionIds ?? [])]),
    docs: unique([...(validator.docs ?? []), ...(finding.docs ?? [])]),
  };
}

function attachCommitGateReferences(gate: CommitGate, validator: Validator): CommitGate {
  return {
    ...gate,
    decisionIds: unique([...(validator.decisionIds ?? []), ...(gate.decisionIds ?? [])]),
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
    if (validator.appliesScopes.length === 0) return query.projectFiles;
    return query.projectFiles.filter((file) => validatorMatchesFile(validator, file));
  }
  const existingFiles = query.files.filter((file) => query.projectFiles.includes(file) || existsSync(path.join(query.rootDir, file)));
  if (validator.appliesScopes.length === 0) return existingFiles;
  return existingFiles.filter((file) => validatorMatchesFile(validator, file));
}
