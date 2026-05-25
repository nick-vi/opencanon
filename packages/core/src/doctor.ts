import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextPaths, Decision } from "./core.ts";
import { discoverProjectFiles, getGitRoot, listFiles, loadImpactSurfaces, relative, validateConfig, validateContext } from "./core.ts";
import { resolveExternalTool } from "./external-tools.ts";
import { isFixAllowed } from "./fixes.ts";
import type { FixMode } from "./fixes.ts";
import { FixModeValue } from "./fixes.ts";
import { validatePatterns } from "./globs.ts";
import { inspectHookInstallations } from "./hook-install.ts";
import type { Validator } from "./validator.ts";
import { factKindValues, validatorScopeValues } from "./contracts.ts";

export const DoctorStatus = {
  Pass: "pass",
  Warn: "warn",
  Fail: "fail",
} as const;
export type DoctorStatus = (typeof DoctorStatus)[keyof typeof DoctorStatus];

const GitArg = {
  Directory: "-C",
} as const;

const doctorTextEncoding = "utf8";
const missingVersion = "missing";
const requiredDaemonBunVersion = "1.3.13";
const engineBindingSuffixes: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
  "win32-x64": "win32-x64-msvc",
};
const generatedIgnoreEntries = [
  ".opencanon/daemon.json",
  ".opencanon/daemon.log",
  ".opencanon/setup.json",
  ".opencanon/commit-approvals.json",
  ".opencanon/*.sqlite",
  ".opencanon/*.sqlite-shm",
  ".opencanon/*.sqlite-wal",
];
const skillGeneratedIgnoreEntries = ["runtime/", "generated/"];

export type DoctorCheck = {
  id: string;
  status: DoctorStatus;
  message: string;
  details?: string[];
};

export type DoctorReport = {
  status: DoctorStatus;
  checks: DoctorCheck[];
};

export type DoctorFixResult = {
  mode: FixMode;
  dryRun: boolean;
  selectedFixes: number;
  appliedFixes: number;
  diagnostics: string[];
  skipped: string[];
};

export function buildDoctorReport(params: { paths: ContextPaths; decisions: Decision[]; validators: Validator[]; runExternalTools?: boolean }): DoctorReport {
  const checks: DoctorCheck[] = [];
  const { paths, decisions, validators } = params;
  const packageJsonPath = path.join(paths.rootDir, "package.json");
  const packageJson = readPackageJson(packageJsonPath);
  const corePackageJson = readPackageJson(path.join(paths.rootDir, "packages/core/package.json"));
  const cliPackageJson = readPackageJson(path.join(paths.rootDir, "packages/cli/package.json"));
  const daemonPackageJson = readPackageJson(path.join(paths.rootDir, "packages/daemon/package.json"));
  const enginePackageJson = readPackageJson(path.join(paths.rootDir, "packages/engine/package.json"));
  const uiPackageJson = readPackageJson(path.join(paths.rootDir, "packages/ui/package.json"));
  const openCanonWorkspace = isOpenCanonFrameworkWorkspace(corePackageJson);

  checks.push({
    id: "config",
    status: DoctorStatus.Pass,
    message: paths.configPath
      ? `Config overrides loaded from ${path.relative(paths.rootDir, paths.configPath)}.`
      : "No opencanon.config.json found; using built-in defaults.",
  });

  const discoveryDiagnostics = validateProjectDiscovery(paths);
  checks.push({
    id: "project-discovery",
    status: discoveryDiagnostics.failures.length > 0 ? DoctorStatus.Fail : discoveryDiagnostics.warnings.length > 0 ? DoctorStatus.Warn : DoctorStatus.Pass,
    message:
      discoveryDiagnostics.failures.length === 0 && discoveryDiagnostics.warnings.length === 0
        ? `Project discovery found ${discoveryDiagnostics.fileCount} files via ${discoveryDiagnostics.source}.`
        : "Project discovery guardrails need attention.",
    details: [...discoveryDiagnostics.failures, ...discoveryDiagnostics.warnings],
  });

  const cacheIgnore = validateCacheIgnore(paths);
  checks.push({
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
  checks.push({
    id: "generated-ignore",
    status: generatedIgnore.status,
    message:
      generatedIgnore.status === DoctorStatus.Pass
        ? "Generated daemon state and runtime artifacts are ignored by Git."
        : generatedIgnore.status === DoctorStatus.Fail
          ? "Generated daemon state or runtime artifacts are not ignored by Git."
          : "Generated artifact ignore rules could not be fully verified.",
    details: generatedIgnore.diagnostics,
  });

  checks.push({
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

  const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
  const contextDiagnostics = [...impactDiagnostics, ...validateContext({ decisions, validators, impactSurfaces, paths })];
  checks.push({
    id: "context-files",
    status: contextDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: contextDiagnostics.length === 0 ? "Context docs and decisions are structurally valid." : "Context docs or decisions are invalid.",
    details: contextDiagnostics,
  });

  const validatorDiagnostics = validateValidators(validators);
  checks.push({
    id: "validators",
    status: validatorDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: validatorDiagnostics.length === 0 ? "Validators are structurally valid." : "Validators have structural issues.",
    details: validatorDiagnostics,
  });

  const fixtureDiagnostics = validateFixturePresence(paths, validators);
  checks.push({
    id: "validator-fixtures",
    status: fixtureDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Warn,
    message: fixtureDiagnostics.length === 0 ? "Each validator has valid and invalid fixtures." : "Some validators are missing fixture coverage.",
    details: fixtureDiagnostics,
  });

  const scriptDiagnostics = validatePackageScripts(packageJson, paths.requiredPackageScripts);
  checks.push({
    id: "package-scripts",
    status: scriptDiagnostics.length === 0 ? DoctorStatus.Pass : DoctorStatus.Fail,
    message: scriptDiagnostics.length === 0 ? "Package scripts expose the OpenCanon shortcut." : "Package scripts are missing required shortcuts.",
    details: scriptDiagnostics,
  });

  const dependencyDiagnostics = validateDependencyPin(packageJson, corePackageJson, cliPackageJson, daemonPackageJson, enginePackageJson, uiPackageJson);
  checks.push({
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
  checks.push({
    id: "external-tools",
    status: externalTools.status,
    message: externalTools.message,
    details: externalTools.details,
  });

  const gitRoot = getGitRoot(paths.rootDir);
  checks.push({
    id: "git",
    status: gitRoot ? DoctorStatus.Pass : DoctorStatus.Warn,
    message: gitRoot ? `Git repository detected at ${gitRoot}.` : "No Git repository detected; --changed and git history context will not work here.",
  });

  const precommit = hasPrecommit(paths.rootDir, gitRoot);
  checks.push({
    id: "precommit",
    status: precommit ? DoctorStatus.Pass : DoctorStatus.Warn,
    message: precommit
      ? "Precommit hook detected."
      : "No precommit hook detected. Consider running opencanon context --check and opencanon validate --check-fixtures before commit.",
  });

  const feedbackHooks = validateFeedbackHooks(paths.rootDir);
  checks.push({
    id: "feedback-hooks",
    status: feedbackHooks.status,
    message: feedbackHooks.message,
    details: feedbackHooks.details,
  });

  const daemonRuntime = validateDaemonRuntime(paths.rootDir);
  checks.push({
    id: "daemon-runtime",
    status: daemonRuntime.status,
    message: daemonRuntime.message,
    details: daemonRuntime.details,
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

  for (const check of report.checks) {
    lines.push(`- [${check.status}] ${check.id}: ${check.message}`);
    for (const detail of check.details ?? []) lines.push(`  - ${detail}`);
  }

  return lines.join("\n");
}

export function applyDoctorFixes(params: { paths: ContextPaths; report: DoctorReport; mode: FixMode; dryRun: boolean; decisions?: Decision[]; validators?: Validator[] }): DoctorFixResult {
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
  const missingDecisionRefs = missingDecisionValidatorRefs(params.decisions ?? [], params.validators ?? []);

  if (missingDecisionRefs.size > 0) {
    if (!isFixAllowed(FixModeValue.Safe, params.mode)) {
      result.skipped.push("decision-validator-refs: safe fix outside requested mode.");
    } else {
      result.selectedFixes += 1;
      if (!params.dryRun) {
        addMissingDecisionValidatorRefs(params.paths, missingDecisionRefs);
        result.appliedFixes += 1;
      }
    }
  }

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
        ensureGitignoreEntries(params.paths.rootDir, generatedIgnoreEntries);
        ensureGitignoreEntries(path.join(params.paths.rootDir, ".agents/skills/opencanon"), skillGeneratedIgnoreEntries);
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
          "#!/bin/sh\nset -e\n\nbun run opencanon context --check\nbun run opencanon validate --check-fixtures\nbun run opencanon validate --changed\n",
        );
        chmodSync(hookPath, 0o755);
        result.appliedFixes += 1;
      }
    }
  }

  return result;
}

function missingDecisionValidatorRefs(decisions: Decision[], validators: Validator[]): Map<string, string[]> {
  const byDecision = new Map(decisions.map((decision) => [decision.id, decision]));
  const missing = new Map<string, string[]>();
  for (const validator of validators) {
    for (const decisionId of validator.decisionIds ?? []) {
      const decision = byDecision.get(decisionId);
      if (!decision || (decision.validatorIds ?? []).includes(validator.id)) continue;
      missing.set(decisionId, [...(missing.get(decisionId) ?? []), validator.id]);
    }
  }
  return missing;
}

function addMissingDecisionValidatorRefs(paths: ContextPaths, missing: Map<string, string[]>): void {
  const decisions = JSON.parse(readFileSync(paths.decisionsPath, doctorTextEncoding)) as Decision[];
  for (const decision of decisions) {
    const validatorIds = missing.get(decision.id);
    if (!validatorIds) continue;
    decision.validatorIds = [...new Set([...(decision.validatorIds ?? []), ...validatorIds])].sort();
  }
  writeFileSync(paths.decisionsPath, `${JSON.stringify(decisions, null, 2)}\n`);
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
  return JSON.parse(readFileSync(packageJsonPath, doctorTextEncoding)) as Record<string, any>;
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
    ".opencanon/daemon.json",
    ".opencanon/daemon.log",
    ".opencanon/setup.json",
    ".opencanon/commit-approvals.json",
    ".opencanon/state.sqlite",
    ".opencanon/state.sqlite-shm",
    ".opencanon/state.sqlite-wal",
    ".agents/skills/opencanon/runtime/cli.js",
    ".agents/skills/opencanon/generated/project.ts",
  ];
  const missing = probes.filter((probe) => spawnSync("git", [GitArg.Directory, paths.rootDir, "check-ignore", "--quiet", "--", probe]).status !== 0);
  if (missing.length === 0) return { status: DoctorStatus.Pass, diagnostics: [] };
  return {
    status: DoctorStatus.Fail,
    diagnostics: [
      `Add generated OpenCanon entries to .gitignore: ${generatedIgnoreEntries.join(", ")}; add ${skillGeneratedIgnoreEntries.join(", ")} to .agents/skills/opencanon/.gitignore. Unignored probes: ${missing.join(", ")}.`,
    ],
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
      for (const issue of validatePatterns(patterns)) diagnostics.push(`Validator ${validator.id}: ${issue}`);
    }
    if (validator.analysisGlobs.length > 0) {
      for (const issue of validatePatterns(validator.analysisGlobs)) diagnostics.push(`Validator ${validator.id}: ${issue}`);
    }
    if (typeof validator.validate !== "function") diagnostics.push(`Validator ${validator.id} needs validate().`);
  }

  return diagnostics;
}

function validateFixturePresence(paths: ContextPaths, validators: Validator[]): string[] {
  const missingValid: string[] = [];
  const missingInvalid: string[] = [];

  for (const validator of validators) {
    if (!existsSync(path.join(paths.fixturesDir, validator.id, "valid.ts"))) missingValid.push(validator.id);
    if (!existsSync(path.join(paths.fixturesDir, validator.id, "invalid.ts"))) missingInvalid.push(validator.id);
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
  daemonPackageJson: Record<string, any> | null,
  enginePackageJson: Record<string, any> | null,
  uiPackageJson: Record<string, any> | null,
): string[] {
  if (!isOpenCanonFrameworkWorkspace(corePackageJson)) return [];
  const dependencies = [
    {
      name: "@codemirror/lang-css",
      version: "6.3.1",
      packageJson: uiPackageJson,
    },
    {
      name: "@codemirror/lang-html",
      version: "6.4.11",
      packageJson: uiPackageJson,
    },
    {
      name: "@codemirror/lang-javascript",
      version: "6.2.5",
      packageJson: uiPackageJson,
    },
    {
      name: "@codemirror/lang-json",
      version: "6.0.2",
      packageJson: uiPackageJson,
    },
    {
      name: "@codemirror/lang-markdown",
      version: "6.5.0",
      packageJson: uiPackageJson,
    },
    {
      name: "@codemirror/lang-python",
      version: "6.2.1",
      packageJson: uiPackageJson,
    },
    {
      name: "@codemirror/lang-rust",
      version: "6.0.2",
      packageJson: uiPackageJson,
    },
    {
      name: "@codemirror/lang-yaml",
      version: "6.1.3",
      packageJson: uiPackageJson,
    },
    {
      name: "@codemirror/language",
      version: "6.12.3",
      packageJson: uiPackageJson,
    },
    { name: "@codemirror/state", version: "6.6.0", packageJson: uiPackageJson },
    { name: "@codemirror/view", version: "6.42.1", packageJson: uiPackageJson },
    { name: "@lezer/highlight", version: "1.2.3", packageJson: uiPackageJson },
    { name: "@napi-rs/cli", version: "3.6.2", packageJson: enginePackageJson },
    { name: "@types/bun", version: "1.3.14", packageJson },
    { name: "@types/node", version: "25.7.0", packageJson },
    {
      name: "@vitejs/plugin-react",
      version: "6.0.1",
      packageJson: uiPackageJson,
    },
    { name: "@types/react", version: "19.2.14", packageJson: uiPackageJson },
    { name: "@types/react-dom", version: "19.2.3", packageJson: uiPackageJson },
    {
      name: "@tanstack/react-query",
      version: "5.100.10",
      packageJson: uiPackageJson,
    },
    {
      name: "@tanstack/react-router",
      version: "1.169.2",
      packageJson: uiPackageJson,
    },
    { name: "lucide-react", version: "1.14.0", packageJson: uiPackageJson },
    { name: "playwright", version: "1.60.0", packageJson },
    { name: "picomatch", version: "4.0.4", packageJson: corePackageJson },
    { name: "react", version: "19.2.6", packageJson: uiPackageJson },
    { name: "react-dom", version: "19.2.6", packageJson: uiPackageJson },
    { name: "react-markdown", version: "10.1.0", packageJson: uiPackageJson },
    { name: "remark-gfm", version: "4.0.1", packageJson: uiPackageJson },
    { name: "vite", version: "8.0.12", packageJson: uiPackageJson },
    { name: "zod", version: "4.4.3", packageJson: corePackageJson },
    { name: "cac", version: "7.0.0", packageJson: cliPackageJson },
    { name: "vitest", version: "4.1.6", packageJson },
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
      if (tool.missingSeverity === "error") failures.push(message);
      else if (tool.missingSeverity === "warning") warnings.push(message);
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
  const allowedRootDependencies = new Set(["@opencanon/cli", "@opencanon/core", "@opencanon/daemon", "@opencanon/engine", "@opencanon/validators"]);
  const misplacedDependencies = Object.keys(packageJson.dependencies ?? {}).filter((dependency) => !allowedRootDependencies.has(dependency));
  return misplacedDependencies.map((dependency) => `${dependency} should be owned by the package that imports it, not the root package.json.`);
}

function validateWorkspacePackageManager(packageJson: Record<string, any> | null): string[] {
  const packageManager = packageJson?.packageManager;
  const expected = `bun@${requiredDaemonBunVersion}`;
  return packageManager === expected ? [] : [`packageManager should be ${expected}, found ${packageManager ?? missingVersion}.`];
}

function validateDaemonRuntime(rootDir: string): {
  status: DoctorStatus;
  message: string;
  details: string[];
} {
  const details: string[] = [];
  const bun = spawnSync("bun", ["--version"], { encoding: doctorTextEncoding });
  const bunVersion = bun.status === 0 ? bun.stdout.trim() : missingVersion;
  if (bunVersion !== requiredDaemonBunVersion) {
    details.push(
      `Bun runtime mismatch: required ${requiredDaemonBunVersion}; found ${bunVersion}. Run bun --version, install the pinned runtime with your runtime manager, then rerun opencanon daemon check.`,
    );
  }

  details.push(...validateBundledRuntime(rootDir));

  return {
    status: details.length === 0 ? DoctorStatus.Pass : DoctorStatus.Warn,
    message: details.length === 0 ? `Bundled daemon runtime is present for ${process.platform}-${process.arch}.` : "Bundled daemon runtime is not ready on this machine.",
    details,
  };
}

function validateBundledRuntime(rootDir: string): string[] {
  const details: string[] = [];
  const skillRoot = path.join(rootDir, ".agents/skills/opencanon");
  for (const runtimeFile of ["runtime/cli.js", "runtime/core.js", "runtime/validators.js", "runtime/daemon.js", "runtime/ui/index.html"]) {
    if (!existsSync(path.join(skillRoot, runtimeFile))) details.push(`Runtime file is missing: ${runtimeFile}.`);
  }

  const engineTarget = `${process.platform}-${process.arch}`;
  const engineSuffix = engineBindingSuffixes[engineTarget];
  if (!engineSuffix) {
    details.push(`Engine runtime is missing for ${engineTarget}.`);
  } else {
    const enginePath = path.join(skillRoot, "runtime/engine", engineTarget, `opencanon.${engineSuffix}.node`);
    if (!existsSync(enginePath)) details.push(`Engine runtime file is missing: ${path.relative(skillRoot, enginePath)}.`);
  }

  return details;
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
