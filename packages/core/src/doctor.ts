import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextPaths } from "./core.ts";
import type { Area } from "./area.ts";
import type { Change } from "./change.ts";
import type { Convention } from "./convention.ts";
import type { Spec } from "./spec.ts";
import { buildDefinitionGraph, DefinitionGraphDiagnosticSeverity, getGitRoot, loadImpactSurfaces, relative, validateContext } from "./core.ts";
import {
  cacheIgnoreEntry,
  ensureAgentEntryFiles,
  ensureGitignoreEntries,
  ensureGitignoreEntry,
  ensureOpenCanonPackageScript,
  errorMessage,
  hasPrecommit,
  isOpenCanonFrameworkWorkspace,
  readPackageJson,
  validateAgentEntryFiles,
  validateAreaDocsInvariant,
  validateCacheIgnore,
  validateChangeDocsInvariant,
  validateCommitApprovalsIgnore,
  validateConventionDocsInvariant,
  validateDependencyPin,
  validateExternalTools,
  validateFeedbackHooks,
  validateFixturePresence,
  validateGeneratedIgnore,
  validatePackageScripts,
  validateProjectAuthoringSupport,
  validateProjectDiscovery,
  validateRuntimeHealth,
  validateRuntimePrerequisites,
  validateSemanticIndex,
  validateSpecDocsInvariant,
  validateValidators,
} from "./doctor-checks.ts";
import {
  DoctorCheckGroup,
  type DoctorKnowledgeInspection,
  DoctorStatus,
  type DoctorCheck,
  type DoctorFixResult,
  type DoctorReport,
  type DoctorRuntimeHealth,
} from "./doctor-types.ts";
import { isFixAllowed } from "./fixes.ts";
import type { FixMode } from "./fixes.ts";
import { FixModeValue } from "./fixes.ts";
import { GeneratedStateIgnoreEntries } from "./generated-state.ts";
import { removeRetiredOpenCanonSkillArtifacts, validateOpenCanonSkillArtifacts, writeOpenCanonSkillArtifacts } from "./opencanon-skill.ts";
import { generateProjectTypes } from "./project-types.ts";
import { createRenderLinkContext } from "./render-links.ts";
import type { Validator } from "./validator.ts";
import { normalizeProducerStatusesForProject } from "./validator.ts";
import type { ProducerStatus } from "./type-facts-provider.ts";
import { ProducerStatusKind } from "./type-facts-provider.ts";

export { DoctorCheckGroup, DoctorStatus } from "./doctor-types.ts";
export { DoctorKnowledgeInspectionKind } from "./doctor-types.ts";
export type { DoctorCheck, DoctorFixResult, DoctorKnowledgeInspection, DoctorReport, DoctorRuntimeHealth } from "./doctor-types.ts";

export function buildDoctorReport(params: { paths: ContextPaths; conventions: Convention[]; validators: Validator[]; areas?: Area[]; specs?: Spec[]; changes?: Change[]; runExternalTools?: boolean; producerStatuses?: ProducerStatus[]; knowledgeInspection?: DoctorKnowledgeInspection; runtimeHealth?: DoctorRuntimeHealth }): DoctorReport {
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

  const semanticIndexDiagnostics = validateSemanticIndex(params.knowledgeInspection);
  pushCheck(DoctorCheckGroup.GeneratedState, {
    id: "semantic-index",
    status: semanticIndexDiagnostics.status,
    message: semanticIndexDiagnostics.message,
    details: semanticIndexDiagnostics.details,
  });

  const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
  const renderLinkContext = createRenderLinkContext({ conventions, areas, specs, changes, impactSurfaces });
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

  const conventionDocsDiagnostics = validateConventionDocsInvariant(paths, conventions, renderLinkContext);
  pushCheck(DoctorCheckGroup.GeneratedState, {
    id: "convention-docs",
    status: conventionDocsDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: conventionDocsDiagnostics.length === 0 ? "Convention docs satisfy their render ownership invariant." : "Convention docs do not match their render ownership invariant.",
    details: conventionDocsDiagnostics,
  });

  const areaDocsDiagnostics = validateAreaDocsInvariant(paths, areas, renderLinkContext);
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

  const specDocsDiagnostics = validateSpecDocsInvariant(paths, specs, renderLinkContext);
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

  const changeDocsDiagnostics = validateChangeDocsInvariant(paths, changes, renderLinkContext);
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

  const scriptDiagnostics = validatePackageScripts(packageJson, paths.requiredPackageScripts, openCanonWorkspace);
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
  const packageScripts = params.report.checks.find((check) => check.id === "package-scripts");
  const openCanonWorkspace = isOpenCanonFrameworkWorkspace(readPackageJson(path.join(params.paths.rootDir, "packages/core/package.json")));
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
          removeRetiredOpenCanonSkillArtifacts(params.paths.rootDir);
          writeOpenCanonSkillArtifacts(params.paths.rootDir);
          result.appliedFixes += 1;
        } catch (error) {
          result.diagnostics.push(`opencanon-skill: ${errorMessage(error)}`);
        }
      }
    }
  }

  if (packageScripts?.status === DoctorStatus.Fail && params.paths.requiredPackageScripts.includes("opencanon")) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("package-scripts: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        try {
          ensureOpenCanonPackageScript(params.paths.rootDir, openCanonWorkspace);
          result.appliedFixes += 1;
        } catch (error) {
          result.diagnostics.push(`package-scripts: ${errorMessage(error)}`);
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
