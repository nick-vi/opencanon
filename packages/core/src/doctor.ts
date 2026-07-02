import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextPaths } from "./core.ts";
import { OpenCanonAgentEntryFiles, patchOpenCanonAgentEntryBlock, validateOpenCanonAgentEntryContent } from "./agent-entry.ts";
import { AreaRenderKind, type Area } from "./area.ts";
import { renderArea, resolveAreaGeneratedDocsPath } from "./area-render.ts";
import { ChangeRenderKind, type Change } from "./change.ts";
import { renderChange, resolveChangeGeneratedDocsPath } from "./change-render.ts";
import { ConventionRenderKind, type Convention } from "./convention.ts";
import { SpecRenderKind, type Spec } from "./spec.ts";
import { renderSpec, resolveSpecGeneratedDocsPath } from "./spec-render.ts";
import { buildDefinitionGraph, DefinitionGraphDiagnosticSeverity, discoverProjectFiles, getGitRoot, loadImpactSurfaces, relative, validateConfig, validateContext } from "./core.ts";
import { renderConvention, resolveConventionGeneratedDocsPath } from "./convention-render.ts";
import { satisfiesMinimumVersion } from "./core-utils.ts";
import { resolveExternalTool } from "./external-tools.ts";
import { isFixAllowed } from "./fixes.ts";
import type { FixMode } from "./fixes.ts";
import { FixModeValue } from "./fixes.ts";
import { GeneratedStateIgnoreEntries, GeneratedStateIgnoreProbePaths } from "./generated-state.ts";
import { validatePatterns } from "./globs.ts";
import { inspectHookInstallations } from "./hook-install.ts";
import { validateOpenCanonSkillArtifacts, writeOpenCanonSkillArtifacts } from "./opencanon-skill.ts";
import {
  buildProjectTypesGeneration,
  generateProjectTypes,
  ProjectAliasesFilePath,
  ProjectCoreAuthoringFilePath,
  ProjectTestingAuthoringFilePath,
  ProjectTypesFilePath,
  ProjectValidatorsAuthoringFilePath,
} from "./project-types.ts";
import type { Validator } from "./validator.ts";
import { normalizeProducerStatusesForProject } from "./validator.ts";
import { ValidatorDomain } from "./validator-types.ts";
import type { ProducerStatus } from "./type-facts-provider.ts";
import { ProducerStatusKind } from "./type-facts-provider.ts";
import { ExternalToolMissingSeverity, factKindValues, validatorScopeValues } from "./contracts.ts";
import type { SemanticIndexSnapshot } from "./contracts.ts";

export const DoctorStatus = {
  Pass: "pass",
  Warn: "warn",
  Fail: "fail",
} as const;
export type DoctorStatus = (typeof DoctorStatus)[keyof typeof DoctorStatus];

export const DoctorCheckGroup = {
  App: "app",
  GeneratedState: "generated-state",
  Install: "install",
  Project: "project",
  ProjectMap: "project-map",
} as const;
export type DoctorCheckGroup = (typeof DoctorCheckGroup)[keyof typeof DoctorCheckGroup];

const SemanticIndexDoctorStatus = {
  Failed: "failed",
  Stale: "stale",
} as const;

const GitArg = {
  Directory: "-C",
} as const;

const doctorTextEncoding = "utf8";
const missingVersion = "missing";
const requiredRuntimeNodeVersion = "24.12.0";
const requiredPackageManager = "npm@11.12.1";

export type DoctorCheck = {
  id: string;
  group: DoctorCheckGroup;
  status: DoctorStatus;
  message: string;
  details?: string[];
};

export type DoctorReport = {
  status: DoctorStatus;
  checks: DoctorCheck[];
};

export type DoctorRuntimeHealth = {
  service?: {
    status: string;
    message?: string;
    registered: boolean;
  };
  project?: {
    status: string;
    message?: string;
    registered: boolean;
    lifecycleStatus?: string;
  };
};

export type DoctorFixResult = {
  mode: FixMode;
  dryRun: boolean;
  selectedFixes: number;
  appliedFixes: number;
  diagnostics: string[];
  skipped: string[];
};

export function buildDoctorReport(params: { paths: ContextPaths; conventions: Convention[]; validators: Validator[]; areas?: Area[]; specs?: Spec[]; changes?: Change[]; runExternalTools?: boolean; producerStatuses?: ProducerStatus[]; semanticIndex?: SemanticIndexSnapshot | null; runtimeHealth?: DoctorRuntimeHealth }): DoctorReport {
  const checks: DoctorCheck[] = [];
  const pushCheck = (group: DoctorCheckGroup, check: Omit<DoctorCheck, "group">): void => {
    checks.push({ group, ...check });
  };
  const { paths, conventions, validators, areas = [], specs = [], changes = [] } = params;
  const packageJsonPath = path.join(paths.rootDir, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  const corePackageJson = readPackageJson(path.join(paths.rootDir, "packages/core/package.json"));
  const cliPackageJson = readPackageJson(path.join(paths.rootDir, "packages/cli/package.json"));
  const runtimePackageJson = readPackageJson(path.join(paths.rootDir, "packages/runtime/package.json"));
  const enginePackageJson = readPackageJson(path.join(paths.rootDir, "packages/engine/package.json"));
  const openCanonWorkspace = isOpenCanonFrameworkWorkspace(corePackageJson);

  pushCheck(DoctorCheckGroup.Project, {
    id: "config",
    status: DoctorStatus.Pass,
    message: paths.configPath
      ? `Config overrides loaded from ${path.relative(paths.rootDir, paths.configPath)}.`
      : "No opencanon.config.json found; using built-in defaults.",
  });

  const discoveryDiagnostics = validateProjectDiscovery(paths);
  pushCheck(DoctorCheckGroup.Project, {
    id: "project-discovery",
    status: discoveryDiagnostics.failures.length > 0 ? DoctorStatus.Fail : discoveryDiagnostics.warnings.length > 0 ? DoctorStatus.Warn : DoctorStatus.Pass,
    message:
      discoveryDiagnostics.failures.length === 0 && discoveryDiagnostics.warnings.length === 0
        ? `Project discovery found ${discoveryDiagnostics.fileCount} files via ${discoveryDiagnostics.source}.`
        : "Project discovery guardrails need attention.",
    details: [...discoveryDiagnostics.failures, ...discoveryDiagnostics.warnings],
  });

  const cacheIgnore = validateCacheIgnore(paths);
  pushCheck(DoctorCheckGroup.GeneratedState, {
    id: "cache-ignore",
    status: cacheIgnore.status,
    message:
      cacheIgnore.status === DoctorStatus.Pass
        ? `Cache directory is ignored by Git: ${cacheIgnoreEntry(paths)}`
        : cacheIgnore.status === DoctorStatus.Fail
          ? "Cache directory is not ignored by Git."
          : "Cache ignore rules could not be fully verified.",
    details: cacheIgnore.diagnostics,
  });

  const generatedIgnore = validateGeneratedIgnore(paths);
  const commitApprovalsIgnore = validateCommitApprovalsIgnore(paths);
  pushCheck(DoctorCheckGroup.GeneratedState, {
    id: "generated-ignore",
    status: generatedIgnore.status,
    message:
      generatedIgnore.status === DoctorStatus.Pass
        ? "Generated OpenCanon state and authoring artifacts are ignored by Git."
        : generatedIgnore.status === DoctorStatus.Fail
          ? "Generated OpenCanon state or authoring artifacts are not ignored by Git."
          : "Generated artifact ignore rules could not be fully verified.",
    details: generatedIgnore.diagnostics,
  });

  pushCheck(DoctorCheckGroup.GeneratedState, {
    id: "commit-approvals-ignore",
    status: commitApprovalsIgnore.status,
    message:
      commitApprovalsIgnore.status === DoctorStatus.Pass
        ? paths.commitApprovalsPersistent
          ? "Commit approval records are configured as persistent."
          : "Ephemeral commit approval records are ignored by Git."
        : commitApprovalsIgnore.status === DoctorStatus.Fail
          ? "Commit approval ignore rules do not match config."
          : "Commit approval ignore rules could not be fully verified.",
    details: commitApprovalsIgnore.diagnostics,
  });

  const projectAuthoringDiagnostics = validateProjectAuthoringSupport(paths);
  pushCheck(DoctorCheckGroup.GeneratedState, {
    id: "project-authoring",
    status: projectAuthoringDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message:
      projectAuthoringDiagnostics.length === 0
        ? "Generated project authoring support is current."
        : "Generated project authoring support is missing or stale.",
    details: projectAuthoringDiagnostics,
  });

  const semanticIndexDiagnostics = validateSemanticIndex(params.semanticIndex);
  pushCheck(DoctorCheckGroup.GeneratedState, {
    id: "semantic-index",
    status: semanticIndexDiagnostics.status,
    message: semanticIndexDiagnostics.message,
    details: semanticIndexDiagnostics.details,
  });

  const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
  const contextDiagnostics = [
    ...impactDiagnostics,
    ...validateContext({
      conventions,
      areas,
      specs,
      changes,
      validators: validators.map((validator) => ({ id: validator.id, conventionIds: validator.conventionIds, docs: validator.docs })),
      impactSurfaces,
      paths,
    }),
  ];
  pushCheck(DoctorCheckGroup.Project, {
    id: "context-files",
    status: contextDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: contextDiagnostics.length === 0 ? "Context docs and conventions are structurally valid." : "Context docs or conventions are invalid.",
    details: contextDiagnostics,
  });

  const definitionGraph = buildDefinitionGraph({
    areas,
    specs,
    changes,
    conventions,
    impactSurfaces,
    validators: validators.map((validator) => ({ id: validator.id, conventionIds: validator.conventionIds })),
  });
  const definitionGraphErrors = definitionGraph.diagnostics.filter((diagnostic) => diagnostic.severity === DefinitionGraphDiagnosticSeverity.Error);
  pushCheck(DoctorCheckGroup.ProjectMap, {
    id: "definition-graph",
    status: definitionGraphErrors.length > 0 ? DoctorStatus.Fail : definitionGraph.diagnostics.length > 0 ? DoctorStatus.Warn : DoctorStatus.Pass,
    message:
      definitionGraph.diagnostics.length === 0
        ? `Definition graph is consistent (${definitionGraph.nodes.length} nodes, ${definitionGraph.edges.length} edges).`
        : "Definition graph has coverage or relationship issues.",
    details: definitionGraph.diagnostics.map((diagnostic) => `${diagnostic.severity} [${diagnostic.code}]: ${diagnostic.message}`),
  });

  const conventionDocsDiagnostics = validateConventionDocsInvariant(paths, conventions);
  pushCheck(DoctorCheckGroup.GeneratedState, {
    id: "convention-docs",
    status: conventionDocsDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: conventionDocsDiagnostics.length === 0 ? "Convention docs satisfy their render ownership invariant." : "Convention docs do not match their render ownership invariant.",
    details: conventionDocsDiagnostics,
  });

  const areaDocsDiagnostics = validateAreaDocsInvariant(paths, areas);
  pushCheck(DoctorCheckGroup.ProjectMap, {
    id: "areas",
    status: areaDocsDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message:
      areas.length === 0
        ? "No area definitions found."
        : areaDocsDiagnostics.length === 0
          ? "Area definitions and generated docs are valid."
          : "Area definitions or generated docs need attention.",
    details: areaDocsDiagnostics,
  });

  const specDocsDiagnostics = validateSpecDocsInvariant(paths, specs);
  pushCheck(DoctorCheckGroup.ProjectMap, {
    id: "specs",
    status: specDocsDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message:
      specs.length === 0
        ? "No spec definitions found."
        : specDocsDiagnostics.length === 0
          ? "Spec definitions and generated docs are valid."
          : "Spec definitions or generated docs need attention.",
    details: specDocsDiagnostics,
  });

  const changeDocsDiagnostics = validateChangeDocsInvariant(paths, changes);
  pushCheck(DoctorCheckGroup.ProjectMap, {
    id: "changes",
    status: changeDocsDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message:
      changes.length === 0
        ? "No change definitions found."
        : changeDocsDiagnostics.length === 0
          ? "Change definitions and generated docs are valid."
          : "Change definitions or generated docs need attention.",
    details: changeDocsDiagnostics,
  });

  const openCanonSkillDiagnostics = validateOpenCanonSkillArtifacts(paths.rootDir);
  pushCheck(DoctorCheckGroup.Install, {
    id: "opencanon-skill",
    status: openCanonSkillDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message:
      openCanonSkillDiagnostics.length === 0
        ? "Managed OpenCanon skill files are installed."
        : "Managed OpenCanon skill files are missing or stale.",
    details: openCanonSkillDiagnostics,
  });

  const validatorDiagnostics = validateValidators(validators);
  pushCheck(DoctorCheckGroup.Project, {
    id: "validators",
    status: validatorDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: validatorDiagnostics.length === 0 ? "Validators are structurally valid." : "Validators have structural issues.",
    details: validatorDiagnostics,
  });

  const fixtureDiagnostics = validateFixturePresence(paths, validators);
  pushCheck(DoctorCheckGroup.Project, {
    id: "validator-fixtures",
    status: fixtureDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Warn,
    message: fixtureDiagnostics.length === 0 ? "Each validator has the fixtures required by its coverage contract." : "Some validators are missing fixture coverage.",
    details: fixtureDiagnostics,
  });

  const scriptDiagnostics = validatePackageScripts(packageJson, paths.requiredPackageScripts);
  pushCheck(DoctorCheckGroup.Install, {
    id: "package-scripts",
    status: scriptDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: scriptDiagnostics.length === 0 ? "Package scripts expose the OpenCanon shortcut." : "Package scripts are missing required shortcuts.",
    details: scriptDiagnostics,
  });

  const dependencyDiagnostics = validateDependencyPin(packageJson, corePackageJson, cliPackageJson, runtimePackageJson, enginePackageJson);
  pushCheck(DoctorCheckGroup.Install, {
    id: "dependencies",
    status: dependencyDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: openCanonWorkspace
      ? dependencyDiagnostics.length === 0
        ? "Dependency ownership and reviewed pins are valid."
        : "Dependency ownership or pinning needs attention."
      : "Dependency ownership and pinning checks are not applicable outside the OpenCanon framework workspace.",
    details: dependencyDiagnostics,
  });

  const externalTools = validateExternalTools(paths, { runCommands: params.runExternalTools === true });
  pushCheck(DoctorCheckGroup.Install, {
    id: "external-tools",
    status: externalTools.status,
    message: externalTools.message,
    details: externalTools.details,
  });

  const gitRoot = getGitRoot(paths.rootDir);
  pushCheck(DoctorCheckGroup.Project, {
    id: "git",
    status: gitRoot ? DoctorStatus.Pass : DoctorStatus.Warn,
    message: gitRoot ? `Git repository detected at ${gitRoot}.` : "No Git repository detected; --changed and git history context will not work here.",
  });

  const precommit = hasPrecommit(paths.rootDir, gitRoot);
  pushCheck(DoctorCheckGroup.Install, {
    id: "precommit",
    status: precommit ? DoctorStatus.Pass : DoctorStatus.Warn,
    message: precommit
      ? "Precommit hook detected."
      : "No precommit hook detected. Consider running opencanon context --check and opencanon validate --check-fixtures before commit.",
  });

  const feedbackHooks = validateFeedbackHooks(paths.rootDir);
  pushCheck(DoctorCheckGroup.Install, {
    id: "feedback-hooks",
    status: feedbackHooks.status,
    message: feedbackHooks.message,
    details: feedbackHooks.details,
  });

  const agentEntryDiagnostics = validateAgentEntryFiles(paths.rootDir);
  pushCheck(DoctorCheckGroup.Install, {
    id: "agent-entry",
    status: agentEntryDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message:
      agentEntryDiagnostics.length === 0
        ? "Agent entry files contain the managed OpenCanon bootstrap block."
        : "Agent entry files need the managed OpenCanon bootstrap block.",
    details: agentEntryDiagnostics,
  });

  const runtimePrerequisites = validateRuntimePrerequisites(paths.rootDir);
  pushCheck(DoctorCheckGroup.App, {
    id: "runtime-prerequisites",
    status: runtimePrerequisites.status,
    message: runtimePrerequisites.message,
    details: runtimePrerequisites.details,
  });

  const runtimeHealth = validateRuntimeHealth(params.runtimeHealth);
  if (runtimeHealth) {
    pushCheck(DoctorCheckGroup.App, {
      id: "runtime-health",
      status: runtimeHealth.status,
      message: runtimeHealth.message,
      details: runtimeHealth.details,
    });
  }

  // Producer-status section: each known type producer's language + kind + detail
  // + warnings. The AUTHORITATIVE status lives in the running runtime (it owns the
  // live producer); the CLI passes it in via `producerStatuses`. Only when no
  // runtime is running do we fall back to a headless resolve (sidecar-only) — which
  // is correct, because then there is no live producer. `not-implemented` is
  // expected (silent zero); `stale`/`crashed`/`missing-*` are loud (warn); `ready`
  // passes. Never inspect the sidecar fs directly here.
  const producers = normalizeProducerStatusesForProject({
    paths,
    validators,
    producers: params.producerStatuses,
  });
  const producerDetails = producers.map((status) => {
    const detail = status.detail ? ` — ${status.detail}` : "";
    const warnings = (status.warnings ?? []).map((warning) => `  warning [${warning.code}]: ${warning.message}`);
    return [`${status.language}: ${status.kind}${detail}`, ...warnings].join("\n");
  });
  const producerProblem = producers.some((status) => status.kind !== ProducerStatusKind.Ready && status.kind !== ProducerStatusKind.NotImplemented);
  pushCheck(DoctorCheckGroup.App, {
    id: "type-producers",
    status: producerProblem ? DoctorStatus.Warn : DoctorStatus.Pass,
    message: producerProblem ? "One or more type producers are not ready." : "Required type producers are ready.",
    details: producerDetails,
  });

  const status = checks.some((check) => check.status === DoctorStatus.Fail)
    ? DoctorStatus.Fail
    : checks.some((check) => check.status === DoctorStatus.Warn)
      ? DoctorStatus.Warn
      : DoctorStatus.Pass;
  return { status, checks };
}

export function renderDoctorMarkdown(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Doctor");
  lines.push("");
  lines.push(`Status: ${report.status}`);
  lines.push("");

  for (const group of doctorCheckGroups(report.checks)) {
    lines.push(`## ${doctorCheckGroupLabel(group)}`);
    lines.push("");
    for (const check of report.checks.filter((item) => item.group === group)) {
    lines.push(`- [${check.status}] ${check.id}: ${check.message}`);
    for (const detail of check.details ?? []) lines.push(`  - ${detail}`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function doctorCheckGroups(checks: DoctorCheck[]): DoctorCheckGroup[] {
  const present = new Set(checks.map((check) => check.group));
  return [
    DoctorCheckGroup.App,
    DoctorCheckGroup.Project,
    DoctorCheckGroup.ProjectMap,
    DoctorCheckGroup.GeneratedState,
    DoctorCheckGroup.Install,
  ].filter((group) => present.has(group));
}

function doctorCheckGroupLabel(group: DoctorCheckGroup): string {
  if (group === DoctorCheckGroup.App) return "App";
  if (group === DoctorCheckGroup.Project) return "Project";
  if (group === DoctorCheckGroup.ProjectMap) return "Project Map";
  if (group === DoctorCheckGroup.GeneratedState) return "Generated State";
  return "Install";
}

export function applyDoctorFixes(params: { paths: ContextPaths; report: DoctorReport; mode: FixMode; dryRun: boolean; conventions?: Convention[]; validators?: Validator[] }): DoctorFixResult {
  const result: DoctorFixResult = {
    mode: params.mode,
    dryRun: params.dryRun,
    selectedFixes: 0,
    appliedFixes: 0,
    diagnostics: [],
    skipped: [],
  };
  const precommit = params.report.checks.find((check) => check.id === "precommit");
  const cacheIgnore = params.report.checks.find((check) => check.id === "cache-ignore");
  const generatedIgnore = params.report.checks.find((check) => check.id === "generated-ignore");
  const commitApprovalsIgnore = params.report.checks.find((check) => check.id === "commit-approvals-ignore");
  const projectAuthoring = params.report.checks.find((check) => check.id === "project-authoring");
  const agentEntry = params.report.checks.find((check) => check.id === "agent-entry");
  const openCanonSkill = params.report.checks.find((check) => check.id === "opencanon-skill");
  if (cacheIgnore?.status === DoctorStatus.Fail) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("cache-ignore: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        ensureGitignoreEntry(params.paths);
        result.appliedFixes += 1;
      }
    }
  }

  if (generatedIgnore?.status === DoctorStatus.Fail) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("generated-ignore: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        ensureGitignoreEntries(params.paths.rootDir, GeneratedStateIgnoreEntries);
        result.appliedFixes += 1;
      }
    }
  }

  if (commitApprovalsIgnore?.status === DoctorStatus.Fail && !params.paths.commitApprovalsPersistent) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("commit-approvals-ignore: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        ensureGitignoreEntries(params.paths.rootDir, [relative(params.paths.rootDir, params.paths.commitApprovalsPath)]);
        result.appliedFixes += 1;
      }
    }
  }

  if (projectAuthoring?.status === DoctorStatus.Fail) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("project-authoring: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        try {
          generateProjectTypes(params.paths.rootDir, params.paths);
          result.appliedFixes += 1;
        } catch (error) {
          result.diagnostics.push(`project-authoring: ${errorMessage(error)}`);
        }
      }
    }
  }

  if (agentEntry?.status === DoctorStatus.Fail) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("agent-entry: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        try {
          ensureAgentEntryFiles(params.paths.rootDir);
          result.appliedFixes += 1;
        } catch (error) {
          result.diagnostics.push(`agent-entry: ${errorMessage(error)}`);
        }
      }
    }
  }

  if (openCanonSkill?.status === DoctorStatus.Fail) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("opencanon-skill: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        try {
          writeOpenCanonSkillArtifacts(params.paths.rootDir);
          result.appliedFixes += 1;
        } catch (error) {
          result.diagnostics.push(`opencanon-skill: ${errorMessage(error)}`);
        }
      }
    }
  }

  if (precommit?.status !== DoctorStatus.Pass) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("precommit: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        const hookDir = path.join(params.paths.rootDir, ".husky");
        const hookPath = path.join(hookDir, "pre-commit");
        mkdirSync(hookDir, { recursive: true });
        writeFileSync(
          hookPath,
          "#!/bin/sh\nset -e\n\nopencanon context --check\nopencanon validate --check-fixtures\nopencanon validate --changed\n",
        );
        chmodSync(hookPath, 0o755);
        result.appliedFixes += 1;
      }
    }
  }

  return result;
}

export function renderDoctorFixMarkdown(result: DoctorFixResult): string {
  const lines: string[] = [];
  lines.push("## Doctor Fixes");
  lines.push("");
  lines.push(`Mode: ${result.mode}${result.dryRun ? " (dry-run)" : ""}`);
  lines.push(`Fixes: ${result.dryRun ? result.selectedFixes : result.appliedFixes}/${result.selectedFixes}`);
  for (const skipped of result.skipped) lines.push(`- skipped ${skipped}`);
  for (const diagnostic of result.diagnostics) lines.push(`- error: ${diagnostic}`);
  return lines.join("\n");
}

function readPackageJson(packageJsonPath: string): Record<string, any> | null {
  if (!existsSync(packageJsonPath)) return null;
  // Degrade, never crash: doctor is the command users run WHEN their repo is
  // broken, so a malformed package.json must become a `null` (handled downstream
  // as "missing"), not an uncaught SyntaxError that aborts the whole report.
  try {
    return JSON.parse(readFileSync(packageJsonPath, doctorTextEncoding)) as Record<string, any>;
  } catch {
    return null;
  }
}

function validateProjectDiscovery(paths: ContextPaths): {
  source: string;
  fileCount: number;
  failures: string[];
  warnings: string[];
} {
  const failures = validateConfig(paths);
  const warnings: string[] = [];

  if (failures.length > 0) {
    return {
      source: String(paths.fileDiscovery),
      fileCount: 0,
      failures,
      warnings,
    };
  }

  const discovery = discoverProjectFiles(paths);
  const source = discovery.source;
  if (discovery.failed) failures.push(...discovery.diagnostics);
  else warnings.push(...discovery.diagnostics);

  return { source, fileCount: discovery.files.length, failures, warnings };
}

function validateConventionDocsInvariant(paths: ContextPaths, conventions: Convention[]): string[] {
  const diagnostics: string[] = [];
  for (const convention of conventions) {
    if (convention.render.kind !== ConventionRenderKind.Generated) continue;

    const resolved = resolveConventionGeneratedDocsPath(paths, convention);
    if (!resolved.ok) {
      diagnostics.push(...resolved.diagnostics);
      continue;
    }

    const docsPath = relative(paths.rootDir, resolved.absolutePath);
    if (!existsSync(resolved.absolutePath)) {
      diagnostics.push(`Convention ${convention.id} generated docs file is missing: ${docsPath}. Run opencanon canon render conventions.`);
      continue;
    }

    const expected = renderConvention(convention, convention.render.style);
    const actual = readFileSync(resolved.absolutePath, doctorTextEncoding);
    if (actual !== expected) {
      diagnostics.push(`Convention ${convention.id} generated docs drifted: ${docsPath}. Run opencanon canon render conventions. ${firstDiffLine(expected, actual)}`);
    }
  }
  return diagnostics;
}

function validateAreaDocsInvariant(paths: ContextPaths, areas: Area[]): string[] {
  const diagnostics: string[] = [];
  for (const area of areas) {
    if (area.render.kind !== AreaRenderKind.Generated) continue;

    const resolved = resolveAreaGeneratedDocsPath(paths, area);
    if (!resolved.ok) {
      diagnostics.push(...resolved.diagnostics);
      continue;
    }

    const docsPath = relative(paths.rootDir, resolved.absolutePath);
    if (!existsSync(resolved.absolutePath)) {
      diagnostics.push(`Area ${area.id} generated docs file is missing: ${docsPath}. Run opencanon canon render areas.`);
      continue;
    }

    const expected = renderArea(area, area.render.style);
    const actual = readFileSync(resolved.absolutePath, doctorTextEncoding);
    if (actual !== expected) {
      diagnostics.push(`Area ${area.id} generated docs drifted: ${docsPath}. Run opencanon canon render areas. ${firstDiffLine(expected, actual)}`);
    }
  }
  return diagnostics;
}

function validateSpecDocsInvariant(paths: ContextPaths, specs: Spec[]): string[] {
  const diagnostics: string[] = [];
  for (const spec of specs) {
    if (spec.render.kind !== SpecRenderKind.Generated) continue;

    const resolved = resolveSpecGeneratedDocsPath(paths, spec);
    if (!resolved.ok) {
      diagnostics.push(...resolved.diagnostics);
      continue;
    }

    const docsPath = relative(paths.rootDir, resolved.absolutePath);
    if (!existsSync(resolved.absolutePath)) {
      diagnostics.push(`Spec ${spec.id} generated docs file is missing: ${docsPath}. Run opencanon canon render specs.`);
      continue;
    }

    const expected = renderSpec(spec, spec.render.style);
    const actual = readFileSync(resolved.absolutePath, doctorTextEncoding);
    if (actual !== expected) {
      diagnostics.push(`Spec ${spec.id} generated docs drifted: ${docsPath}. Run opencanon canon render specs. ${firstDiffLine(expected, actual)}`);
    }
  }
  return diagnostics;
}

function validateChangeDocsInvariant(paths: ContextPaths, changes: Change[]): string[] {
  const diagnostics: string[] = [];
  for (const change of changes) {
    if (change.render.kind !== ChangeRenderKind.Generated) continue;

    const resolved = resolveChangeGeneratedDocsPath(paths, change);
    if (!resolved.ok) {
      diagnostics.push(...resolved.diagnostics);
      continue;
    }

    const docsPath = relative(paths.rootDir, resolved.absolutePath);
    if (!existsSync(resolved.absolutePath)) {
      diagnostics.push(`Change ${change.id} generated docs file is missing: ${docsPath}. Run opencanon canon render changes.`);
      continue;
    }

    const expected = renderChange(change, change.render.style);
    const actual = readFileSync(resolved.absolutePath, doctorTextEncoding);
    if (actual !== expected) {
      diagnostics.push(`Change ${change.id} generated docs drifted: ${docsPath}. Run opencanon canon render changes. ${firstDiffLine(expected, actual)}`);
    }
  }
  return diagnostics;
}

function firstDiffLine(expected: string, actual: string): string {
  const expectedLines = expected.split("\n");
  const actualLines = actual.split("\n");
  const maxLength = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < maxLength; index += 1) {
    if (expectedLines[index] === actualLines[index]) continue;
    return `First diff at line ${index + 1}: expected ${previewLine(expectedLines[index])}, actual ${previewLine(actualLines[index])}.`;
  }
  return "Content differs.";
}

function previewLine(line: string | undefined): string {
  if (line === undefined) return "<missing>";
  const trimmed = line.length > 120 ? `${line.slice(0, 117)}...` : line;
  return JSON.stringify(trimmed);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateCacheIgnore(paths: ContextPaths): {
  status: DoctorStatus;
  diagnostics: string[];
} {
  if (validateConfig(paths).length > 0) {
    return {
      status: DoctorStatus.Warn,
      diagnostics: ["Cache ignore check skipped because config is invalid."],
    };
  }
  if (!getGitRoot(paths.rootDir)) {
    return {
      status: DoctorStatus.Warn,
      diagnostics: ["No Git repository detected; cannot verify cache ignore rules."],
    };
  }

  const result = spawnSync("git", [GitArg.Directory, paths.rootDir, "check-ignore", "--quiet", "--", `${cacheIgnoreEntry(paths)}analysis.json`]);
  if (result.status === 0) return { status: DoctorStatus.Pass, diagnostics: [] };
  return {
    status: DoctorStatus.Fail,
    diagnostics: [`Add ${cacheIgnoreEntry(paths)} to .gitignore so generated parser cache files are never staged.`],
  };
}

function validateGeneratedIgnore(paths: ContextPaths): {
  status: DoctorStatus;
  diagnostics: string[];
} {
  if (!getGitRoot(paths.rootDir)) {
    return {
      status: DoctorStatus.Warn,
      diagnostics: ["No Git repository detected; cannot verify generated artifact ignore rules."],
    };
  }
  const probes = [
    ...GeneratedStateIgnoreProbePaths,
    ProjectAliasesFilePath,
    ProjectCoreAuthoringFilePath,
    ProjectTestingAuthoringFilePath,
    ProjectTypesFilePath,
    ProjectValidatorsAuthoringFilePath,
  ];
  const missing = probes.filter((probe) => spawnSync("git", [GitArg.Directory, paths.rootDir, "check-ignore", "--quiet", "--", probe]).status !== 0);
  if (missing.length === 0) return { status: DoctorStatus.Pass, diagnostics: [] };
  return {
    status: DoctorStatus.Fail,
    diagnostics: [
      `Add generated OpenCanon entries to .gitignore: ${GeneratedStateIgnoreEntries.join(", ")}. Unignored probes: ${missing.join(", ")}.`,
    ],
  };
}

function validateProjectAuthoringSupport(paths: ContextPaths): string[] {
  try {
    const plan = buildProjectTypesGeneration(paths.rootDir, paths);
    return plan.files.flatMap((file) => {
      const filePath = path.join(paths.rootDir, file.path);
      if (!existsSync(filePath)) return [`Generated project authoring file is missing: ${file.path}. Run opencanon doctor --fix.`];
      const actual = readFileSync(filePath, doctorTextEncoding);
      if (actual === file.content) return [];
      return [`Generated project authoring file drifted: ${file.path}. Run opencanon doctor --fix. ${firstDiffLine(file.content, actual)}`];
    });
  } catch (error) {
    return [`Project authoring support could not be checked: ${errorMessage(error)}`];
  }
}

function validateAgentEntryFiles(rootDir: string): string[] {
  const diagnostics: string[] = [];
  for (const relativePath of OpenCanonAgentEntryFiles) {
    const filePath = path.join(rootDir, relativePath);
    if (!existsSync(filePath)) {
      diagnostics.push(`${relativePath} is missing. Run opencanon doctor --fix.`);
      continue;
    }
    diagnostics.push(...validateOpenCanonAgentEntryContent(readFileSync(filePath, doctorTextEncoding), relativePath));
  }
  return diagnostics;
}

function ensureAgentEntryFiles(rootDir: string): void {
  for (const relativePath of OpenCanonAgentEntryFiles) {
    const filePath = path.join(rootDir, relativePath);
    const current = existsSync(filePath) ? readFileSync(filePath, doctorTextEncoding) : "";
    const patched = patchOpenCanonAgentEntryBlock(current);
    if (patched.diagnostics.length > 0) throw new Error(`${relativePath}: ${patched.diagnostics.join("; ")}`);
    if (!patched.changed) continue;
    writeFileSync(filePath, patched.content);
  }
}

function validateSemanticIndex(index: SemanticIndexSnapshot | null | undefined): { status: DoctorStatus; message: string; details: string[] } {
  if (index === undefined) {
    return {
      status: DoctorStatus.Pass,
      message: "Context index status is verified by the project runtime when available.",
      details: [],
    };
  }
  if (index === null) {
    return {
      status: DoctorStatus.Warn,
      message: "No context index snapshot has been written yet.",
      details: ["Run a project reindex from the app or `opencanon project index` to build generated search state."],
    };
  }

  const details: string[] = [];
  if (!index.version.trim()) details.push("Context index version is missing.");
  if (!index.chunkerVersion.trim()) details.push("Context index chunker version is missing.");
  if (!index.producerVersion.trim()) details.push("Context index producer version is missing.");
  if (!index.sourceInventoryHash.trim()) details.push("Context index source inventory hash is missing.");
  if (!index.chunkTreeHash.trim()) details.push("Context index chunk tree hash is missing.");
  if (!index.identityHash.trim()) details.push("Context index identity hash is missing.");
  if (!index.provider.id.trim()) details.push("Context index provider id is missing.");
  if (!index.provider.modelId.trim()) details.push("Context index model id is missing.");
  if (!index.provider.configHash.trim()) details.push("Context index provider config hash is missing.");
  if (index.provider.dimensions < 1) details.push("Context index provider dimensions must be positive.");
  if (index.chunkCount !== index.vectorCount) details.push(`Context index chunk/vector counts differ (${index.chunkCount} chunks, ${index.vectorCount} vectors).`);
  if (index.status === SemanticIndexDoctorStatus.Failed) details.push(...index.diagnostics.map((diagnostic) => diagnostic.message));

  return {
    status: details.length > 0 ? DoctorStatus.Fail : index.status === SemanticIndexDoctorStatus.Stale ? DoctorStatus.Warn : DoctorStatus.Pass,
    message: details.length > 0
      ? "Context index identity or freshness metadata is invalid."
      : index.status === SemanticIndexDoctorStatus.Stale
        ? "Context index exists but is stale."
        : `Context index is ${index.status} (${index.chunkCount} chunks).`,
    details,
  };
}

function validateRuntimeHealth(runtimeHealth: DoctorRuntimeHealth | undefined): { status: DoctorStatus; message: string; details: string[] } | undefined {
  if (!runtimeHealth) return undefined;
  const details: string[] = [];
  const service = runtimeHealth.service;
  if (service?.registered && service.status !== "running") {
    details.push(`Service is ${service.status}${service.message ? `: ${service.message}` : ""}`);
  }
  const project = runtimeHealth.project;
  if (project?.registered && project.status !== "running") {
    const lifecycle = project.lifecycleStatus ? `, lifecycle ${project.lifecycleStatus}` : "";
    details.push(`Project runtime is ${project.status}${lifecycle}${project.message ? `: ${project.message}` : ""}`);
  }
  const registered = Boolean(service?.registered || project?.registered);
  if (!registered) {
    return {
      status: DoctorStatus.Pass,
      message: "No OpenCanon service or project runtime is registered.",
      details,
    };
  }
  return {
    status: details.length > 0 ? DoctorStatus.Fail : DoctorStatus.Pass,
    message: details.length > 0 ? "Registered OpenCanon runtime state is unhealthy." : "Registered OpenCanon runtime state is healthy.",
    details,
  };
}

function validateCommitApprovalsIgnore(paths: ContextPaths): {
  status: DoctorStatus;
  diagnostics: string[];
} {
  if (!getGitRoot(paths.rootDir)) {
    return {
      status: DoctorStatus.Warn,
      diagnostics: ["No Git repository detected; cannot verify commit approval ignore rules."],
    };
  }

  const approvalPath = relative(paths.rootDir, paths.commitApprovalsPath);
  const result = spawnSync("git", [GitArg.Directory, paths.rootDir, "check-ignore", "--quiet", "--", approvalPath]);
  const ignored = result.status === 0;
  if (!paths.commitApprovalsPersistent && ignored) return { status: DoctorStatus.Pass, diagnostics: [] };
  if (paths.commitApprovalsPersistent && !ignored) return { status: DoctorStatus.Pass, diagnostics: [] };
  return {
    status: DoctorStatus.Fail,
    diagnostics: [
      paths.commitApprovalsPersistent
        ? `${approvalPath} is ignored, but commitApprovalsPersistent is true. Remove the ignore rule or set commitApprovalsPersistent to false.`
        : `Add ${approvalPath} to .gitignore so local commit approval records are never staged.`,
    ],
  };
}

function cacheIgnoreEntry(paths: ContextPaths): string {
  return `${relative(paths.rootDir, paths.cacheDir).replace(/\/$/, "")}/`;
}

function ensureGitignoreEntry(paths: ContextPaths): void {
  const entry = cacheIgnoreEntry(paths);
  ensureGitignoreEntries(paths.rootDir, [entry]);
}

function ensureGitignoreEntries(rootDir: string, entries: string[]): void {
  const gitignorePath = path.join(rootDir, ".gitignore");
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, doctorTextEncoding) : "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const missingEntries = entries.filter((entry) => !lines.includes(entry));
  if (missingEntries.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  mkdirSync(path.dirname(gitignorePath), { recursive: true });
  writeFileSync(gitignorePath, `${current}${prefix}${missingEntries.join("\n")}\n`);
}

function validateValidators(validators: Validator[]): string[] {
  const diagnostics: string[] = [];
  const ids = new Set<string>();

  for (const validator of validators) {
    if (!validator.id) diagnostics.push("Validator is missing id.");
    if (ids.has(validator.id)) diagnostics.push(`Duplicate validator id: ${validator.id}`);
    ids.add(validator.id);
    if (!validator.topics || validator.topics.length === 0) diagnostics.push(`Validator ${validator.id} needs at least one topic.`);
    if (!validatorScopeValues.includes(validator.scope)) diagnostics.push(`Validator ${validator.id} has invalid scope.`);
    for (const fact of validator.facts) {
      if (!factKindValues.includes(fact)) diagnostics.push(`Validator ${validator.id} has invalid fact kind: ${fact}`);
    }
    for (const patterns of validator.appliesScopes) {
      if (patterns.length === 0 && !validatorTargetsFilePatterns(validator)) continue;
      for (const issue of validatePatterns(patterns)) diagnostics.push(`Validator ${validator.id}: ${issue}`);
    }
    if (validator.analysisGlobs.length > 0) {
      for (const issue of validatePatterns(validator.analysisGlobs)) diagnostics.push(`Validator ${validator.id}: ${issue}`);
    }
    if (typeof validator.validate !== "function") diagnostics.push(`Validator ${validator.id} needs validate().`);
  }

  return diagnostics;
}

function validatorTargetsFilePatterns(validator: Validator): boolean {
  return validator.domain === ValidatorDomain.File || validator.domain === ValidatorDomain.ImportEdge;
}

function validateFixturePresence(paths: ContextPaths, validators: Validator[]): string[] {
  const missingValid: string[] = [];
  const missingInvalid: string[] = [];

  for (const validator of validators) {
    if (!existsSync(path.join(paths.fixturesDir, validator.id, "valid.ts"))) missingValid.push(validator.id);
    if (validator.fixtures !== "valid-only" && !existsSync(path.join(paths.fixturesDir, validator.id, "invalid.ts"))) missingInvalid.push(validator.id);
  }

  const diagnostics: string[] = [];
  if (missingValid.length > 0) diagnostics.push(`Missing valid fixtures: ${missingValid.length} validator(s).`);
  if (missingInvalid.length > 0) diagnostics.push(`Missing invalid fixtures: ${missingInvalid.length} validator(s).`);
  for (const validatorId of [...new Set([...missingValid, ...missingInvalid])].slice(0, 20)) {
    const cases = [missingValid.includes(validatorId) ? "valid" : "", missingInvalid.includes(validatorId) ? "invalid" : ""].filter(Boolean).join(", ");
    diagnostics.push(`${validatorId}: missing ${cases} fixture files.`);
  }
  const omitted = new Set([...missingValid, ...missingInvalid]).size - 20;
  if (omitted > 0) diagnostics.push(`${omitted} additional validator(s) omitted from fixture summary.`);
  return diagnostics;
}

function validatePackageScripts(packageJson: Record<string, any> | null, required: string[]): string[] {
  if (!packageJson) return ["package.json is missing."];
  const scripts = packageJson.scripts ?? {};
  return required.filter((script) => !scripts[script]).map((script) => `Missing package script: ${script}`);
}

function validateDependencyPin(
  packageJson: Record<string, any> | null,
  corePackageJson: Record<string, any> | null,
  cliPackageJson: Record<string, any> | null,
  _runtimePackageJson: Record<string, any> | null,
  enginePackageJson: Record<string, any> | null,
): string[] {
  if (!isOpenCanonFrameworkWorkspace(corePackageJson)) return [];
  const dependencies = [
    { name: "@napi-rs/cli", version: "3.6.2", packageJson: enginePackageJson },
    { name: "@types/node", version: "26.1.0", packageJson },
    { name: "esbuild", version: "0.28.1", packageJson },
    { name: "esbuild-wasm", version: "0.28.1", packageJson: corePackageJson },
    { name: "picomatch", version: "4.0.4", packageJson: corePackageJson },
    { name: "zod", version: "4.4.3", packageJson: corePackageJson },
    { name: "cac", version: "7.0.0", packageJson: cliPackageJson },
    { name: "vitest", version: "4.1.9", packageJson },
  ];

  return [
    ...validateRootDependencyOwnership(packageJson),
    ...validateWorkspacePackageManager(packageJson),
    ...dependencies.flatMap((dependency) => {
      const version = dependency.packageJson?.dependencies?.[dependency.name] ?? dependency.packageJson?.devDependencies?.[dependency.name];
      return version === dependency.version ? [] : [`${dependency.name} should be pinned to ${dependency.version}, found ${version ?? missingVersion}.`];
    }),
  ];
}

function validateExternalTools(
  paths: ContextPaths,
  options: { runCommands: boolean },
): {
  status: DoctorStatus;
  message: string;
  details: string[];
} {
  const configDiagnostics = validateConfig(paths).filter((diagnostic) => diagnostic.startsWith("externalTools"));
  if (configDiagnostics.length > 0) {
    return {
      status: DoctorStatus.Fail,
      message: "External tool config is invalid.",
      details: configDiagnostics,
    };
  }

  const entries = Object.entries(paths.externalTools ?? {});
  if (entries.length === 0) {
    return {
      status: DoctorStatus.Pass,
      message: "No external tools configured.",
      details: [],
    };
  }
  if (!options.runCommands) {
    return {
      status: DoctorStatus.Warn,
      message: "External tool declarations were not executed.",
      details: ["Run opencanon doctor --run-external-tools to verify configured external tools."],
    };
  }

  const failures: string[] = [];
  const warnings: string[] = [];
  const details: string[] = [];

  for (const [name] of entries) {
    const tool = resolveExternalTool(name, paths.externalTools);
    const args = [...tool.args, ...tool.versionArgs];
    const result = spawnSync(tool.command, args, {
      cwd: paths.rootDir,
      encoding: doctorTextEncoding,
      timeout: tool.timeoutMs,
      maxBuffer: 64 * 1024,
    });
    const label = `${name}: ${[tool.command, ...args].join(" ")}`;

    if (result.error && isMissingCommandError(result.error)) {
      const message = `${name}: missing command ${tool.command}.`;
      if (tool.missingSeverity === ExternalToolMissingSeverity.Error) failures.push(message);
      else if (tool.missingSeverity === ExternalToolMissingSeverity.Warning) warnings.push(message);
      else details.push(message);
      continue;
    }

    if (result.error) {
      warnings.push(`${name}: could not inspect ${tool.command}: ${result.error.message}`);
      continue;
    }

    const output = firstOutputLine(result.stdout) ?? firstOutputLine(result.stderr);
    if (result.status === 0) {
      details.push(output ? `${label} -> ${output}` : `${label} passed.`);
      continue;
    }

    warnings.push(output ? `${label} exited ${String(result.status)}: ${output}` : `${label} exited ${String(result.status)}.`);
  }

  return {
    status: failures.length > 0 ? DoctorStatus.Fail : warnings.length > 0 ? DoctorStatus.Warn : DoctorStatus.Pass,
    message: failures.length === 0 && warnings.length === 0 ? `External tools are available (${entries.length}).` : "External tool declarations need attention.",
    details: [...failures, ...warnings, ...details],
  };
}

function firstOutputLine(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
}

function isMissingCommandError(error: Error): boolean {
  return "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function isOpenCanonFrameworkWorkspace(corePackageJson: Record<string, any> | null): boolean {
  return corePackageJson?.name === "@opencanon/core";
}

function validateRootDependencyOwnership(packageJson: Record<string, any> | null): string[] {
  if (!packageJson) return [];
  const allowedRootDependencies = new Set(["@opencanon/service-contracts", "@opencanon/cli", "@opencanon/core", "@opencanon/distribution", "@opencanon/runtime", "@opencanon/engine", "@opencanon/validators"]);
  const misplacedDependencies = Object.keys(packageJson.dependencies ?? {}).filter((dependency) => !allowedRootDependencies.has(dependency));
  return misplacedDependencies.map((dependency) => `${dependency} should be owned by the package that imports it, not the root package.json.`);
}

function validateWorkspacePackageManager(packageJson: Record<string, any> | null): string[] {
  const packageManager = packageJson?.packageManager;
  return packageManager === requiredPackageManager ? [] : [`packageManager should be ${requiredPackageManager}, found ${packageManager ?? missingVersion}.`];
}

function validateRuntimePrerequisites(_rootDir: string): {
  status: DoctorStatus;
  message: string;
  details: string[];
} {
  const details: string[] = [];
  const nodeVersion = process.versions.node ?? missingVersion;
  if (!satisfiesMinimumVersion(nodeVersion, requiredRuntimeNodeVersion)) {
    details.push(
      `Node runtime mismatch: required >=${requiredRuntimeNodeVersion}; found ${nodeVersion}. Run node --version, install a supported Node runtime with your runtime manager, then rerun opencanon project check.`,
    );
  }

  return {
    status: details.length === 0 ? DoctorStatus.Pass : DoctorStatus.Warn,
    message: details.length === 0 ? `OpenCanon local runtime prerequisites are ready for ${process.platform}-${process.arch}.` : "OpenCanon local runtime prerequisites are not ready on this machine.",
    details,
  };
}

function hasPrecommit(rootDir: string, gitRoot: string | null): boolean {
  const candidates = [
    path.join(rootDir, ".husky/pre-commit"),
    path.join(rootDir, ".git/hooks/pre-commit"),
    gitRoot ? path.join(gitRoot, ".husky/pre-commit") : "",
    gitRoot ? path.join(gitRoot, ".git/hooks/pre-commit") : "",
  ].filter(Boolean);

  return candidates.some((candidate) => existsSync(candidate));
}

function validateFeedbackHooks(rootDir: string): {
  status: DoctorStatus;
  message: string;
  details: string[];
} {
  const inspections = inspectHookInstallations(rootDir, "project");
  const installed = inspections.filter((inspection) => inspection.installed);
  const invalid = installed.filter((inspection) => !inspection.valid);

  if (invalid.length > 0) {
    return {
      status: DoctorStatus.Warn,
      message: "Some installed feedback hooks are incomplete.",
      details: invalid.flatMap((inspection) => inspection.details.map((detail) => `${inspection.host}: ${detail}`)),
    };
  }

  if (installed.length === 0) {
    return {
      status: DoctorStatus.Warn,
      message: "No project feedback hooks are installed.",
      details: ["Run opencanon hook install codex, claude, opencode, or --all to enable post-write feedback."],
    };
  }

  return {
    status: DoctorStatus.Pass,
    message: `Feedback hooks installed for ${installed.map((inspection) => inspection.host).join(", ")}.`,
    details: [],
  };
}
