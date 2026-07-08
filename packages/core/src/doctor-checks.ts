import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ContextPaths } from "./core.ts";
import { discoverProjectFiles, getGitRoot, relative, validateConfig } from "./core.ts";
import { OpenCanonAgentEntryFiles, patchOpenCanonAgentEntryBlock, validateOpenCanonAgentEntryContent } from "./agent-entry.ts";
import { AreaRenderKind, type Area } from "./area.ts";
import { renderArea, resolveAreaGeneratedDocsPath } from "./area-render.ts";
import { ChangeRenderKind, type Change } from "./change.ts";
import { renderChange, resolveChangeGeneratedDocsPath } from "./change-render.ts";
import { ConventionRenderKind, type Convention } from "./convention.ts";
import { renderConvention, resolveConventionGeneratedDocsPath } from "./convention-render.ts";
import { SpecRenderKind, type Spec } from "./spec.ts";
import { renderSpec, resolveSpecGeneratedDocsPath } from "./spec-render.ts";
import { satisfiesMinimumVersion } from "./core-utils.ts";
import { ExternalToolMissingSeverity, factKindValues, validatorScopeValues, type SemanticIndexSnapshot } from "./contracts.ts";
import { DoctorStatus, type DoctorRuntimeHealth } from "./doctor-types.ts";
import { resolveExternalTool } from "./external-tools.ts";
import { GeneratedStateIgnoreEntries, GeneratedStateIgnoreProbePaths } from "./generated-state.ts";
import { validatePatterns } from "./globs.ts";
import { inspectHookInstallations } from "./hook-install.ts";
import {
  buildProjectTypesGeneration,
  ProjectAliasesFilePath,
  ProjectCoreAuthoringFilePath,
  ProjectTestingAuthoringFilePath,
  ProjectTypesFilePath,
  ProjectValidatorsAuthoringFilePath,
} from "./project-types.ts";
import type { RenderLinkContext } from "./render-links.ts";
import type { Validator } from "./validator.ts";
import { ValidatorDomain } from "./validator-types.ts";

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
const SourceOpenCanonCliScript = "node packages/cli/src/index.ts";

export function readPackageJson(packageJsonPath: string): Record<string, any> | null {
  if (!existsSync(packageJsonPath)) return null;
  try {
    return JSON.parse(readFileSync(packageJsonPath, doctorTextEncoding)) as Record<string, any>;
  } catch {
    return null;
  }
}

export function validateProjectDiscovery(paths: ContextPaths): {
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

export function validateConventionDocsInvariant(paths: ContextPaths, conventions: Convention[], renderLinkContext: RenderLinkContext): string[] {
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

    const expected = renderConvention(convention, convention.render.style, renderLinkContext);
    const actual = readFileSync(resolved.absolutePath, doctorTextEncoding);
    if (actual !== expected) {
      diagnostics.push(`Convention ${convention.id} generated docs drifted: ${docsPath}. Run opencanon canon render conventions. ${firstDiffLine(expected, actual)}`);
    }
  }
  return diagnostics;
}

export function validateAreaDocsInvariant(paths: ContextPaths, areas: Area[], renderLinkContext: RenderLinkContext): string[] {
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

    const expected = renderArea(area, area.render.style, renderLinkContext);
    const actual = readFileSync(resolved.absolutePath, doctorTextEncoding);
    if (actual !== expected) diagnostics.push(`Area ${area.id} generated docs drifted: ${docsPath}. Run opencanon canon render areas. ${firstDiffLine(expected, actual)}`);
  }
  return diagnostics;
}

export function validateSpecDocsInvariant(paths: ContextPaths, specs: Spec[], renderLinkContext: RenderLinkContext): string[] {
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

    const expected = renderSpec(spec, spec.render.style, renderLinkContext);
    const actual = readFileSync(resolved.absolutePath, doctorTextEncoding);
    if (actual !== expected) diagnostics.push(`Spec ${spec.id} generated docs drifted: ${docsPath}. Run opencanon canon render specs. ${firstDiffLine(expected, actual)}`);
  }
  return diagnostics;
}

export function validateChangeDocsInvariant(paths: ContextPaths, changes: Change[], renderLinkContext: RenderLinkContext): string[] {
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

    const expected = renderChange(change, change.render.style, renderLinkContext);
    const actual = readFileSync(resolved.absolutePath, doctorTextEncoding);
    if (actual !== expected) diagnostics.push(`Change ${change.id} generated docs drifted: ${docsPath}. Run opencanon canon render changes. ${firstDiffLine(expected, actual)}`);
  }
  return diagnostics;
}

export function firstDiffLine(expected: string, actual: string): string {
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

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function validateCacheIgnore(paths: ContextPaths): {
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

export function validateGeneratedIgnore(paths: ContextPaths): {
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
    diagnostics: [`Add generated OpenCanon entries to .gitignore: ${GeneratedStateIgnoreEntries.join(", ")}. Unignored probes: ${missing.join(", ")}.`],
  };
}

export function validateProjectAuthoringSupport(paths: ContextPaths): string[] {
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

export function validateAgentEntryFiles(rootDir: string): string[] {
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

export function ensureAgentEntryFiles(rootDir: string): void {
  for (const relativePath of OpenCanonAgentEntryFiles) {
    const filePath = path.join(rootDir, relativePath);
    const current = existsSync(filePath) ? readFileSync(filePath, doctorTextEncoding) : "";
    const patched = patchOpenCanonAgentEntryBlock(current);
    if (patched.diagnostics.length > 0) throw new Error(`${relativePath}: ${patched.diagnostics.join("; ")}`);
    if (!patched.changed) continue;
    writeFileSync(filePath, patched.content);
  }
}

export function validateSemanticIndex(index: SemanticIndexSnapshot | null | undefined): { status: DoctorStatus; message: string; details: string[] } {
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

export function validateRuntimeHealth(runtimeHealth: DoctorRuntimeHealth | undefined): { status: DoctorStatus; message: string; details: string[] } | undefined {
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

export function validateCommitApprovalsIgnore(paths: ContextPaths): {
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

export function cacheIgnoreEntry(paths: ContextPaths): string {
  return `${relative(paths.rootDir, paths.cacheDir).replace(/\/$/, "")}/`;
}

export function ensureGitignoreEntry(paths: ContextPaths): void {
  const entry = cacheIgnoreEntry(paths);
  ensureGitignoreEntries(paths.rootDir, [entry]);
}

export function ensureGitignoreEntries(rootDir: string, entries: string[]): void {
  const gitignorePath = path.join(rootDir, ".gitignore");
  const current = existsSync(gitignorePath) ? readFileSync(gitignorePath, doctorTextEncoding) : "";
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const missingEntries = entries.filter((entry) => !lines.includes(entry));
  if (missingEntries.length === 0) return;

  const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
  mkdirSync(path.dirname(gitignorePath), { recursive: true });
  writeFileSync(gitignorePath, `${current}${prefix}${missingEntries.join("\n")}\n`);
}

export function validateValidators(validators: Validator[]): string[] {
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

export function validateFixturePresence(paths: ContextPaths, validators: Validator[]): string[] {
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

export function validatePackageScripts(packageJson: Record<string, any> | null, required: string[], openCanonWorkspace: boolean): string[] {
  if (!packageJson) return ["package.json is missing."];
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  const diagnostics = required.filter((script) => !scripts[script]).map((script) => `Missing package script: ${script}`);
  if (required.includes("opencanon") && scripts.opencanon !== undefined && !isExpectedOpenCanonPackageScript(scripts.opencanon, openCanonWorkspace)) {
    diagnostics.push(`package.json scripts.opencanon should be "opencanon", found ${JSON.stringify(scripts.opencanon)}. Run opencanon doctor --fix.`);
  }
  return diagnostics;
}

function isExpectedOpenCanonPackageScript(value: unknown, openCanonWorkspace: boolean): boolean {
  return value === "opencanon" || (openCanonWorkspace && value === SourceOpenCanonCliScript);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function ensureOpenCanonPackageScript(rootDir: string, openCanonWorkspace: boolean): void {
  const packageJsonPath = path.join(rootDir, "package.json");
  let packageJson: Record<string, any>;
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as unknown;
    packageJson = isRecord(parsed) ? parsed : {};
  } catch (error) {
    throw new Error(`Could not update package.json scripts: ${error instanceof Error ? error.message : String(error)}`);
  }
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  const openCanonScript = openCanonWorkspace ? SourceOpenCanonCliScript : "opencanon";
  writeFileSync(
    packageJsonPath,
    `${JSON.stringify(
      {
        ...packageJson,
        scripts: {
          ...scripts,
          opencanon: openCanonScript,
        },
      },
      null,
      2,
    )}\n`,
  );
}

export function validateDependencyPin(
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

export function validateExternalTools(
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

export function isOpenCanonFrameworkWorkspace(corePackageJson: Record<string, any> | null): boolean {
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

export function validateRuntimePrerequisites(_rootDir: string): {
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

export function hasPrecommit(rootDir: string, gitRoot: string | null): boolean {
  const candidates = [
    path.join(rootDir, ".husky/pre-commit"),
    path.join(rootDir, ".git/hooks/pre-commit"),
    gitRoot ? path.join(gitRoot, ".husky/pre-commit") : "",
    gitRoot ? path.join(gitRoot, ".git/hooks/pre-commit") : "",
  ].filter(Boolean);

  return candidates.some((candidate) => existsSync(candidate));
}

export function validateFeedbackHooks(rootDir: string): {
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
