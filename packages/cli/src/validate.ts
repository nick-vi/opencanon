import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { booleanOption, fixModeOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";
import {
  createCommitApprovalContext,
  getCommitGateFiles,
  commitGateApprovalChoices,
  commitGateAgentProtocol,
  commitGateFallbackProtocol,
  materializeFixture,
  createPaths,
  fail,
  getChangedFiles,
  isSupportedSourceFile,
  listFiles,
  loadCommitApprovalsWithDiagnostics,
  matchesProjectFileScope,
  resolveGoverningConventionsForFiles,
  toPendingCommitGates,
  relative,
  resolveCommitGates,
  resolveRootDir,
  savePendingCommitGates,
  splitList,
  toRepoRelativePath,
  unique,
  validateConfig,
} from "@opencanon/core";
import { Format } from "@opencanon/core";
import { applyFindingFixes } from "@opencanon/core";
import type { FixMode } from "@opencanon/core";
import { createProfiler, renderProfileMarkdown } from "@opencanon/core";
import type { Finding, RuntimeValidatorCatalog, Validator } from "@opencanon/core";
import { createRuntime, createValidationContextFromFixture, createValidationContextFromFixtureFile, flushValidationContextCache, validateFindings } from "@opencanon/core";
import type { ValidationResult } from "@opencanon/core";
import type { ResolvedCommitGate } from "@opencanon/core";
import { selectValidators, validatorGraphHash, validatorMatchesFile } from "@opencanon/core";
import { RuntimeApiRoute, withRuntimeClient } from "./runtime-client.ts";
import { DiagnosticSeverity, ProducerStatusKind, ValidatorDomain, ValidatorOutcomeStatus } from "@opencanon/core";
import { BatchProducerPolicy, InteractiveProducerPolicy } from "@opencanon/core";

// Single source of truth for fixture case names; reference members instead of inlining the strings.
const FixtureCase = { Valid: "valid", Invalid: "invalid", Fixed: "fixed" } as const;
type FixtureCase = (typeof FixtureCase)[keyof typeof FixtureCase];
const ProjectValidationRequestTimeoutMs = 5 * 60 * 1000;

type Query = {
  files: string[];
  skippedFiles: string[];
  topics: string[];
  validatorIds: string[];
  format: Format;
  checkFixtures: boolean;
  changed: boolean;
  project: boolean;
  list: boolean;
  fixMode?: FixMode;
  dryRun: boolean;
  profile: boolean;
  strictWarnings: boolean;
  requireProducers: string[];
  strictProducers: boolean;
  help: boolean;
};

let rootDir = "";
let paths: ReturnType<typeof createPaths>;

export async function runValidateCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  rootDir = resolveRootDir(cwd);
  paths = createPaths(rootDir);
  const query = parseArgs(args, cwd);
  if (query.help) {
    printHelp();
    return;
  }

  assertValidConfig(paths);
  assertProducerGateMode(query);
  resolveChangedFiles(query);

  if (query.list) {
    const catalog = await withRuntimeClient(cwd, (client) => client.get<RuntimeValidatorCatalog>(`${RuntimeApiRoute.Validators}?limit=500`));
    const rows = catalog.validators.map((validator) => ({
      id: validator.id,
      severity: validator.severity,
      summary: validator.summary,
      topics: validator.topics,
      applies: validator.appliesScopes.length === 0 ? ["<project>"] : validator.appliesScopes.map((patterns) => patterns.join(" && ")),
      conventionIds: validator.conventionIds ?? [],
      docs: validator.docs ?? [],
    }));
    if (query.format === Format.Json) writeJson({ validators: rows });
    else console.log(rows.map((row) => `- ${row.id} (${row.severity}) topics=${row.topics.join(",")}${row.summary ? ` summary=${row.summary}` : ""}`).join("\n"));
    return;
  }

  if (query.checkFixtures) {
    const profiler = createProfiler(query.profile);
    const project = await profiler.measureAsync("load.context", () => loadProjectContext(rootDir));
    const validators = project.validators;
    const fixtureValidators = selectValidators(validators, {
      topics: query.topics,
      validatorIds: query.validatorIds,
    });
    const result = await profiler.measureAsync("fixtures.check", () => checkFixtures(fixtureValidators, createRuntime(paths, project.conventions), profiler));
    if (query.format === Format.Json) {
      writeJson({ ...result, profile: query.profile ? profiler.entries() : undefined });
    } else {
      console.log(renderFixtureResult(result));
      if (query.profile) console.log(`\n${renderProfileMarkdown(profiler.entries())}`);
    }
    process.exit(result.failed === 0 ? 0 : 1);
  }

  if (query.changed && query.files.length === 0) {
    if (query.format === Format.Json) writeJson(emptyValidationResult());
    else console.log("No changed files.");
    return;
  }

  if (!query.project && query.files.length === 0 && query.skippedFiles.length > 0) {
    const result = emptyValidationResult();
    if (query.format === Format.Json) writeJson(result);
    else console.log(renderFindings(result));
    return;
  }

  if (!query.project && query.files.length === 0) {
    printHelp();
    process.exit(1);
  }

  const noRuntimeResult = await resolveNoRuntimeFileValidation(query);
  if (noRuntimeResult) {
    if (query.format === Format.Json) writeJson(noRuntimeResult);
    else console.log(renderFindings(noRuntimeResult));
    process.exit(validationExitCode(noRuntimeResult, query));
  }

  let result = await withRuntimeClient(
    cwd,
    (client) =>
      client.post<ValidationResult>(RuntimeApiRoute.Validate, {
        files: query.files,
        topics: query.topics,
        validatorIds: query.validatorIds,
        project: query.project,
        fixMode: query.fixMode,
        dryRun: query.dryRun,
        profile: query.profile,
        strictProducers: query.strictProducers,
        producerPolicy: query.project ? BatchProducerPolicy : InteractiveProducerPolicy,
      }),
    query.project
      ? {
          requestTimeoutMs: ProjectValidationRequestTimeoutMs,
        }
      : {},
  );
  result = query.changed ? resolveValidationCommitGates(result, true) : { ...result, commitGates: [] };
  result = requireReadyProducers(result, query.requireProducers);

  if (query.format === Format.Json) writeJson(result);
  else console.log(renderFindings(result));
  process.exit(validationExitCode(result, query));
}

export function validationExitCode(result: ValidationResult, query: Pick<Query, "changed" | "strictWarnings" | "strictProducers">): number {
  if (result.diagnostics.length > 0 || result.fixes?.diagnostics.length) return 1;
  if (result.findings.some((finding) => finding.severity === DiagnosticSeverity.Error)) return 1;
  // Outcomes, not findings, drive producer/runtime exit codes (meta is OFF findings).
  // A validator-runtime error outcome is always nonzero. Producer skips are
  // advisory (exit 0) unless --strict-producers escalates them.
  const outcomes = result.validatorOutcomes ?? [];
  if (outcomes.some((outcome) => outcome.status === ValidatorOutcomeStatus.Error)) return 1;
  if (query.strictProducers && outcomes.some((outcome) => outcome.status === ValidatorOutcomeStatus.Skipped && outcome.producer)) return 1;
  if (query.changed && (result.commitGates ?? []).some((gate) => gate.status !== "approved")) return 1;
  if (query.strictWarnings && result.findings.some((finding) => finding.severity === DiagnosticSeverity.Warning)) return 1;
  return 0;
}

function assertValidConfig(paths: ReturnType<typeof createPaths>): void {
  const diagnostics = validateConfig(paths);
  if (diagnostics.length === 0) return;
  console.error("OpenCanon config is invalid:\n");
  for (const diagnostic of diagnostics) console.error(`- ${diagnostic}`);
  process.exit(1);
}

function assertProducerGateMode(query: Query): void {
  if (query.requireProducers.length === 0 || (!query.list && !query.checkFixtures)) return;
  fail("--require-producer applies to validation runs and cannot be combined with --list or --check-fixtures.");
}

export function requireReadyProducers(result: ValidationResult, required: string[]): ValidationResult {
  const diagnostics = required.flatMap((language) => {
    const snapshot = result.producerSnapshot[language];
    if (snapshot?.kind === ProducerStatusKind.Ready) return [];
    const status = snapshot?.kind ?? ProducerStatusKind.NotImplemented;
    const generation = snapshot ? ` at generation ${snapshot.generation}` : "";
    return [
      `Required producer ${language} did not back this validation result as ready (status: ${status}${generation}). ` +
        "Install the language producer prerequisites or run `opencanon analyze --typed`, then validate again.",
    ];
  });
  return diagnostics.length === 0 ? result : { ...result, diagnostics: [...result.diagnostics, ...diagnostics] };
}

function parseArgs(args: string[], cwd: string): Query {
  const cli = cac("opencanon validate");
  cli.option("-h, --help", "Show help.");
  cli.option("--check-fixtures", "Validate validator fixtures.");
  cli.option("--changed", "Validate changed Git files.");
  cli.option("--project", "Run validators across the full project.");
  cli.option("--list", "List validators.");
  cli.option("--dry-run", "Show selected fixes without writing files.");
  cli.option("--fix [mode]", "Apply structured fixes.");
  cli.option("--profile", "Show validation timing breakdown.");
  cli.option("--strict-warnings", "Exit nonzero when warnings are present.");
  cli.option("--require-producer <langs>", "Fail unless this validation result used ready named type producers (comma-separated).");
  cli.option("--strict-producers", "Escalate every validator producer skip to an error (nonzero exit).");
  cli.option("--format <format>", "Output format.");
  cli.option("--topic <topic>", "Run validators for a topic.");
  cli.option("--topics <topics>", "Run validators for topics.");
  cli.option("--validator <id>", "Run one validator.");
  cli.option("--files <path>", "Validate a file path.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [
    "help",
    "h",
    "checkFixtures",
    "changed",
    "project",
    "list",
    "dryRun",
    "fix",
    "profile",
    "strictWarnings",
    "requireProducer",
    "strictProducers",
    "format",
    "topic",
    "topics",
    "validator",
    "files",
  ]);

  const fileTargets = normalizeValidationFileTargets(rootDir, cwd, [...stringValues(options.files), ...parsed.args.map(String)]);
  const query: Query = {
    files: fileTargets.files,
    skippedFiles: fileTargets.skippedFiles,
    topics: unique([...stringValues(options.topic), ...stringValues(options.topics)].flatMap(splitList)),
    validatorIds: unique(stringValues(options.validator).flatMap(splitList)),
    format: formatOption(options.format),
    checkFixtures: booleanOption(options.checkFixtures),
    changed: booleanOption(options.changed),
    project: booleanOption(options.project),
    list: booleanOption(options.list),
    fixMode: fixModeOption(options.fix),
    dryRun: booleanOption(options.dryRun),
    profile: booleanOption(options.profile),
    strictWarnings: booleanOption(options.strictWarnings),
    requireProducers: unique(stringValues(options.requireProducer).flatMap(splitList)),
    strictProducers: booleanOption(options.strictProducers),
    help: booleanOption(options.help) || booleanOption(options.h),
  };
  return query;
}

function normalizeValidationFileTargets(rootDir: string, cwd: string, values: string[]): { files: string[]; skippedFiles: string[] } {
  const files: string[] = [];
  const skippedFiles: string[] = [];
  for (const value of values) {
    const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(cwd, value);
    const relativeToRoot = path.relative(rootDir, absolute);
    if (relativeToRoot.startsWith("..") || path.isAbsolute(relativeToRoot)) {
      skippedFiles.push(value);
      continue;
    }
    files.push(toRepoRelativePath(rootDir, value, cwd));
  }
  return {
    files: unique(files),
    skippedFiles: unique(skippedFiles),
  };
}

function emptyValidationResult(): ValidationResult {
  return {
    files: [],
    validators: [],
    validatorGraphHash: validatorGraphHash([]),
    findingCount: 0,
    diagnostics: [],
    findings: [],
    validatorOutcomes: [],
    producerSnapshot: {},
    commitGates: [],
    governingConventions: resolveGoverningConventionsForFiles({
      files: [],
      conventions: [],
      impactSurfaces: [],
    }),
  };
}

function resolveChangedFiles(query: Query): void {
  if (!query.changed) return;
  const result = getChangedFiles(rootDir);
  if (!result.gitRoot) fail(result.diagnostics.join("\n"));
  query.files = unique([...query.files, ...result.files.filter((file) => matchesProjectFileScope(paths, file))]);
}

async function resolveNoRuntimeFileValidation(query: Query): Promise<ValidationResult | undefined> {
  if (query.project || query.files.length === 0 || query.fixMode || query.dryRun || query.profile || query.requireProducers.length > 0) return undefined;

  const project = await loadProjectContext(rootDir);
  const selectedValidators = selectValidators(project.validators, {
    topics: query.topics,
    validatorIds: query.validatorIds,
  });
  const runtime = createRuntime(paths, project.conventions, {
    areas: project.areas,
    specs: project.specs,
    changes: project.changes,
  });
  const existingFiles = query.files.filter((file) => existsSync(path.join(rootDir, file)));
  const runnable = selectedValidators.filter((validator) => validatorCanRunForFiles(validator, existingFiles, runtime));
  if (runnable.length > 0) return undefined;

  const findings: Finding[] = query.files
    .filter((file) => !existsSync(path.join(rootDir, file)))
    .map((file) => ({
      validatorId: "file-exists",
      severity: DiagnosticSeverity.Error,
      file,
      line: 1,
      message: "File does not exist.",
      fix: {
        safety: "manual",
        description: "Create the file or remove it from the validation target set.",
      },
    }));
  return {
    files: query.files,
    validators: selectedValidators.map((validator) => validator.id),
    validatorGraphHash: validatorGraphHash(selectedValidators),
    findingCount: findings.length,
    diagnostics: [],
    findings,
    validatorOutcomes: [],
    producerSnapshot: {},
    commitGates: [],
    governingConventions: resolveGoverningConventionsForFiles({
      files: query.files,
      conventions: project.conventions,
      impactSurfaces: project.impactSurfaces,
    }),
  };
}

function validatorCanRunForFiles(
  validator: Validator,
  existingFiles: string[],
  runtime: Pick<ReturnType<typeof createRuntime>, "definitions">,
): boolean {
  const targetFiles = validator.appliesScopes.length === 0
    ? validatorTargetsExplicitFiles(validator) ? existingFiles : []
    : existingFiles.filter((file) => validatorMatchesFile(validator, file));
  if (targetFiles.length > 0) return true;
  if (validator.domain === ValidatorDomain.Definition) return targetsDefinitionSource(existingFiles, runtime);
  return false;
}

function validatorTargetsExplicitFiles(validator: Validator): boolean {
  return validator.domain === ValidatorDomain.File || validator.domain === ValidatorDomain.ImportEdge;
}

function targetsDefinitionSource(files: string[], runtime: Pick<ReturnType<typeof createRuntime>, "definitions">): boolean {
  const definitionSources = new Set(
    runtime.definitions
      .all()
      .map((definition) => definition.source?.split("#", 1)[0])
      .filter((source): source is string => Boolean(source)),
  );
  return files.some((file) => definitionSources.has(file));
}

async function checkFixtures(validators: Validator[], runtime = createRuntime(paths, []), profiler = createProfiler(false)) {
  const checks: Array<{ validatorId: string; case: "valid" | "invalid" | "fixed"; file: string; passed: boolean; findings: Finding[]; details?: string[] }> = [];
  const findingValidationContext = {
    paths,
    conventionIds: new Set(runtime.conventions.all.map((convention) => convention.id)),
  };

  for (const validator of validators) {
    // Typed rules whose findings need checked types the ephemeral fixture harness
    // cannot produce declare `fixtures: "valid-only"`; they require only a `valid.ts`
    // proving no false positive and are otherwise covered by a unit test.
    const fixtureCases = validator.fixtures === "valid-only" ? (["valid"] as const) : (["valid", "invalid"] as const);
    for (const fixtureCase of fixtureCases) {
      const fixturePath = path.join(paths.fixturesDir, validator.id, `${fixtureCase}.ts`);
      if (!existsSync(fixturePath)) {
        checks.push({
          validatorId: validator.id,
          case: fixtureCase,
          file: relative(rootDir, fixturePath),
          passed: false,
          findings: [],
          details: [`Missing required fixture file: ${relative(rootDir, fixturePath)}`],
        });
        continue;
      }
      const ctx = await createValidationContextFromFixtureFile({ fixtureFile: fixturePath, validator });
      let findings: Finding[] = [];
      let details: string[] = [];
      let files: string[] = [];
      try {
        findings = await profiler.measureAsync(`fixture.${validator.id}.${fixtureCase}`, () => Promise.resolve(validator.validate({ ctx, runtime })));
        details = validateFindings(validator, findings, findingValidationContext);
        files = ctx.files.map((file) => file.path);
      } finally {
        flushValidationContextCache(ctx);
      }
      checks.push({
        validatorId: validator.id,
        case: fixtureCase,
        file: files.join(", ") || "<none>",
        passed: (fixtureCase === FixtureCase.Valid ? findings.length === 0 : findings.length > 0) && details.length === 0,
        findings,
        details,
      });
    }

    const fixedPath = path.join(paths.fixturesDir, validator.id, "fixed.ts");
    if (!existsSync(fixedPath)) continue;

    const invalidPath = path.join(paths.fixturesDir, validator.id, "invalid.ts");
    if (!existsSync(invalidPath)) continue;
    const details: string[] = [];
    let afterFindings: Finding[] = [];
    let invalidFixture: Awaited<ReturnType<typeof materializeFixture>> | undefined;
    let fixedFixture: Awaited<ReturnType<typeof materializeFixture>> | undefined;
    let fixedOutputFiles: string[] = [];
    try {
      invalidFixture = await materializeFixture(invalidPath);
      fixedFixture = await materializeFixture(fixedPath);
      const expectedFixture = fixedFixture;
      fixedOutputFiles = listFiles(expectedFixture.rootDir, isFixtureComparableFile).map((file) => relative(expectedFixture.rootDir, file));
      const beforeCtx = createValidationContextFromFixture({
        rootDir: invalidFixture.rootDir,
        validator,
        directories: invalidFixture.directories,
        targetFiles: invalidFixture.targetFiles,
        analysisFiles: invalidFixture.analysisFiles,
      });
      const beforeFindings = await Promise.resolve(validator.validate({ ctx: beforeCtx, runtime }));
      details.push(...validateFindings(validator, beforeFindings, findingValidationContext));
      flushValidationContextCache(beforeCtx);
      const fixResult = applyFindingFixes({
        rootDir: invalidFixture.rootDir,
        findings: beforeFindings,
        mode: "all",
        dryRun: false,
      });
      const afterCtx = createValidationContextFromFixture({
        rootDir: invalidFixture.rootDir,
        validator,
        directories: invalidFixture.directories,
        targetFiles: invalidFixture.targetFiles,
        analysisFiles: invalidFixture.analysisFiles,
      });
      afterFindings = await Promise.resolve(validator.validate({ ctx: afterCtx, runtime }));
      flushValidationContextCache(afterCtx);
      details.push(...fixResult.diagnostics);
      details.push(...compareFixtureTrees(invalidFixture.rootDir, fixedFixture.rootDir));
      if (beforeFindings.length === 0) details.push("Invalid fixture had no findings before fix.");
      if (fixResult.appliedEdits === 0) details.push("No fix edits were applied.");
      if (afterFindings.length > 0) details.push("Fixed fixture still has findings.");
    } finally {
      invalidFixture?.cleanup();
      fixedFixture?.cleanup();
    }

    checks.push({
      validatorId: validator.id,
      case: "fixed",
      file: fixedOutputFiles.join(", ") || "fixed.ts",
      passed: details.length === 0,
      findings: afterFindings,
      details,
    });
  }

  return {
    passed: checks.filter((check) => check.passed).length,
    failed: checks.filter((check) => !check.passed).length,
    checks,
  };
}

function renderFindings(result: ValidationResult): string {
  const lines: string[] = [];
  const commitGates = (result.commitGates ?? []) as ResolvedCommitGate[];
  lines.push("# OpenCanon Validation");
  lines.push("");
  lines.push(`Files: ${result.files.length > 0 ? result.files.join(", ") : "<project>"}`);
  lines.push(`Validators: ${result.validators.join(", ")}`);
  lines.push(`Findings: ${result.findingCount}`);
  const skippedOutcomes = (result.validatorOutcomes ?? []).filter((outcome) => outcome.status !== ValidatorOutcomeStatus.Ran);
  if (skippedOutcomes.length > 0) {
    const skipped = skippedOutcomes.filter((outcome) => outcome.status === ValidatorOutcomeStatus.Skipped).length;
    const errored = skippedOutcomes.filter((outcome) => outcome.status === ValidatorOutcomeStatus.Error).length;
    lines.push(`Outcomes: ${skipped} skipped, ${errored} errored validators`);
  }
  if (commitGates.length > 0) {
    lines.push(`Commit gates: ${commitGates.filter((gate) => gate.status !== "approved").length} unresolved, ${commitGates.filter((gate) => gate.status === "approved").length} approved`);
  }
  if (result.fixes) {
    lines.push(`Fix mode: ${result.fixes.mode}${result.fixes.dryRun ? " (dry-run)" : ""}`);
    lines.push(`Fix edits: ${result.fixes.dryRun ? result.fixes.selectedEdits : result.fixes.appliedEdits}/${result.fixes.selectedEdits}`);
  }
  lines.push("");

  if (result.diagnostics.length > 0) {
    lines.push("Diagnostics:");
    for (const diagnostic of result.diagnostics) lines.push(`- ${diagnostic}`);
    lines.push("");
  }

  if (result.fixes && (result.fixes.diagnostics.length > 0 || result.fixes.files.length > 0 || result.fixes.skipped.length > 0)) {
    lines.push("Fixes:");
    for (const file of result.fixes.files) lines.push(`- ${file}`);
    for (const skipped of result.fixes.skipped) {
      lines.push(`- skipped ${skipped.validatorId} at ${skipped.file}:${skipped.line} (${skipped.safety}): ${skipped.reason}`);
    }
    for (const diagnostic of result.fixes.diagnostics) lines.push(`- error: ${diagnostic}`);
    lines.push("");
  }

  if (commitGates.some((gate) => gate.status !== "approved")) {
    lines.push("Commit Gates:");
    for (const gate of commitGates.filter((item) => item.status !== "approved")) {
      lines.push(`- ${gate.id} (${gate.validatorId})`);
      lines.push(`  ${gate.title}`);
      lines.push(`  Reason: ${gate.reason}`);
      if (gate.file) lines.push(`  File: ${gate.file}${gate.line ? `:${gate.line}` : ""}`);
      if (gate.conventionIds && gate.conventionIds.length > 0) lines.push(`  Conventions: ${gate.conventionIds.join(", ")}`);
      if (gate.impactSurfaceIds && gate.impactSurfaceIds.length > 0) lines.push(`  Impact surfaces: ${gate.impactSurfaceIds.join(", ")}`);
      for (const evidence of gate.evidence ?? []) {
        const location = evidence.file ? `${evidence.file}${evidence.line ? `:${evidence.line}` : ""}` : "";
        lines.push(`  Evidence: ${[location, evidence.message].filter(Boolean).join(" ")}`);
      }
      lines.push(`  Record after explicit user approval: opencanon gate approve ${gate.id} --summary "<user explicit answer to the gate question>" --via agent`);
    }
    renderGoverningConventions(lines, result.governingConventions);
    lines.push("");
    lines.push("AGENT ACTION REQUIRED:");
    lines.push("- You are blocked by an OpenCanon commit gate.");
    for (const instruction of commitGateAgentProtocol()) lines.push(`- ${instruction}`);
    lines.push("- Present these choices:");
    for (const choice of commitGateApprovalChoices()) lines.push(`  - ${choice.label}: ${choice.description}`);
    lines.push("");
    lines.push("Commit Gate Policy:");
    lines.push("- These are not normal findings. They block commit flows until user intent is clarified.");
    lines.push("- Approvals are bound to the current Git diff, config hash, and validator graph.");
    lines.push("- If the diff changes, the gate must be approved again.");
    lines.push("");
    lines.push("Agent Metadata:");
    lines.push("");
    lines.push("```json");
    lines.push(
      JSON.stringify(
        {
          kind: "opencanon.commitGateApprovalRequired",
          agentAction: "request_user_input",
          preferredToolNames: ["request_user_input", "ask_user"],
          plainChatFallbackAllowed: true,
          fallbackProtocol: commitGateFallbackProtocol(),
          agentProtocol: commitGateAgentProtocol(),
          choices: commitGateApprovalChoices(),
          pending: toPendingCommitGates(commitGates),
          governingConventions: result.governingConventions,
        },
        null,
        2,
      ),
    );
    lines.push("```");
    lines.push("");
  }

  if (skippedOutcomes.length > 0) {
    lines.push("Skipped/Errored Validators (not findings):");
    for (const outcome of skippedOutcomes) {
      const label = outcome.status === ValidatorOutcomeStatus.Error ? "error" : "skipped";
      const producer = outcome.producer ? ` [${outcome.producer.language} gen ${outcome.producer.generation}]` : "";
      lines.push(`- [${label}] ${outcome.validatorId}${producer}: ${outcome.reason ?? ""}`);
    }
    lines.push("");
  }

  if (result.findings.length === 0) {
    lines.push("No findings.");
    if (result.profile) {
      lines.push("");
      lines.push(renderProfileMarkdown(result.profile));
    }
    return lines.join("\n");
  }

  for (const finding of result.findings) {
    lines.push(`- [${finding.severity}] ${finding.file}:${finding.line} ${finding.validatorId}`);
    lines.push(`  ${finding.message}`);
    if (finding.fix) {
      lines.push(`  Fix (${finding.fix.safety}): ${finding.fix.description}`);
      if (finding.fix.command) lines.push(`  Command: ${finding.fix.command}`);
      if (finding.fix.edits && finding.fix.edits.length > 0) lines.push(`  Edits: ${finding.fix.edits.length}`);
    }
    if (finding.conventionIds && finding.conventionIds.length > 0) lines.push(`  Conventions: ${finding.conventionIds.join(", ")}`);
    if (finding.docs && finding.docs.length > 0) lines.push(`  Docs: ${finding.docs.join(", ")}`);
  }
  if (result.findings.length > 0) {
    lines.push("");
    lines.push("Finding Resolution Policy:");
    lines.push("- Any finding must be addressed before the agent completes the task.");
    lines.push("- Fix code to match the current convention whenever the finding is valid.");
    lines.push("- If the convention runtime is wrong, fix it and add or update valid/invalid fixtures.");
    lines.push("- If the convention itself changed, ask the user before editing conventions with this template:");
    lines.push("");
    lines.push("```text");
    lines.push("Convention update needed");
    lines.push("Finding: <validator-id> at <file:line>");
    lines.push("Current convention: <convention-id or topic>");
    lines.push("Why current canon does not fit: <short reason>");
    lines.push("Proposed new required pattern: <specific rule>");
    lines.push("Code impact: <files/layers affected>");
    lines.push("Convention impact: <conventions/fixtures to update>");
    lines.push("Exception needed: no by default; yes only for external contracts, persisted data, migrations, or integration formats.");
    lines.push("```");
    lines.push("");
    lines.push("Severity:");
    lines.push("- error: blocking finding; CLI/CI exits nonzero.");
    lines.push("- warning: non-blocking finding; CLI exits zero by default, or nonzero with --strict-warnings.");
    lines.push("");
    lines.push("Audit documented exceptions with:");
    lines.push("");
    lines.push("```bash");
    lines.push("opencanon context --list-exceptions");
    lines.push("```");
  }
  if (result.profile) {
    lines.push("");
    lines.push(renderProfileMarkdown(result.profile));
  }
  return lines.join("\n");
}

function renderGoverningConventions(lines: string[], governingConventions: ValidationResult["governingConventions"]): void {
  if (!governingConventions || governingConventions.conventions.length === 0) return;
  lines.push("");
  lines.push("Governing Conventions:");
  for (const convention of governingConventions.conventions) {
    lines.push(`- ${convention.id}: ${convention.title}`);
    lines.push(`  Rule: ${convention.rule}`);
    if (convention.docs.length > 0) lines.push(`  Docs: ${convention.docs.join(", ")}`);
    if (convention.impactSurfaceIds.length > 0) lines.push(`  Impact surfaces: ${convention.impactSurfaceIds.join(", ")}`);
  }
  if (governingConventions.truncated) {
    lines.push(`- ${governingConventions.omittedConventions} more relevant convention(s) omitted from commit-gate feedback.`);
  }
}

function resolveValidationCommitGates(result: ValidationResult, updatePendingCache: boolean): ValidationResult {
  if ((result.commitGates ?? []).length === 0 && !updatePendingCache) return result;
  const approvalContext = createCommitApprovalContext(paths, result.validatorGraphHash);
  const approvals = loadCommitApprovalsWithDiagnostics(paths);
  const scopedGates = commitGatesForStagedFiles(result.commitGates ?? [], approvalContext.stagedFiles);
  const resolved = resolveCommitGates(scopedGates, approvals.approvals, approvalContext);
  if (updatePendingCache) {
    savePendingCommitGates(paths, {
      context: approvalContext,
      gates: resolved,
      diagnostics: [...approvalContext.diagnostics, ...approvals.diagnostics],
      governingConventions: result.governingConventions,
    });
  }
  return {
    ...result,
    diagnostics: [...result.diagnostics, ...approvalContext.diagnostics, ...approvals.diagnostics],
    commitGates: resolved,
  };
}

function commitGatesForStagedFiles(gates: NonNullable<ValidationResult["commitGates"]>, stagedFiles: string[]): NonNullable<ValidationResult["commitGates"]> {
  if (stagedFiles.length === 0) return gates;
  const staged = new Set(stagedFiles);
  return gates.filter((gate) => {
    const files = getCommitGateFiles(gate);
    return files.length === 0 || files.some((file) => staged.has(file));
  });
}

type FixtureResult = Awaited<ReturnType<typeof checkFixtures>>;

function renderFixtureResult(result: FixtureResult): string {
  const lines: string[] = [];
  lines.push("# Validator Fixtures");
  lines.push("");
  lines.push(`Passed: ${result.passed}`);
  lines.push(`Failed: ${result.failed}`);
  lines.push("");
  for (const check of result.checks) {
    const status = check.passed ? "PASS" : "FAIL";
    lines.push(`- ${status} ${check.validatorId}/${check.case}/${check.file}`);
    if (!check.passed) lines.push(`  Findings: ${check.findings.length}`);
    for (const detail of check.details ?? []) lines.push(`  ${detail}`);
  }
  return lines.join("\n");
}

function compareFixtureTrees(actualRoot: string, expectedRoot: string): string[] {
  const diagnostics: string[] = [];
  const expectedFiles = listFiles(expectedRoot, isFixtureComparableFile).map((file) => relative(expectedRoot, file));
  const actualFiles = listFiles(actualRoot, isFixtureComparableFile).map((file) => relative(actualRoot, file));
  const allFiles = unique([...expectedFiles, ...actualFiles]);

  for (const file of allFiles) {
    const expectedPath = path.join(expectedRoot, file);
    const actualPath = path.join(actualRoot, file);
    if (!existsSync(expectedPath)) {
      diagnostics.push(`Unexpected fixed output file: ${file}`);
      continue;
    }
    if (!existsSync(actualPath)) {
      diagnostics.push(`Missing fixed output file: ${file}`);
      continue;
    }
    const expected = readFileSync(expectedPath, "utf8");
    const actual = readFileSync(actualPath, "utf8");
    if (expected !== actual) diagnostics.push(`Fixed output differs: ${file}`);
  }

  return diagnostics;
}

function isFixtureComparableFile(file: string): boolean {
  const relativeFile = file.split(path.sep).join("/");
  return !relativeFile.includes("/.opencanon/") && isSupportedSourceFile(file);
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Usage:
  opencanon validate --files <paths...>
  opencanon validate --files <paths...> --topic <topic>
  opencanon validate --files <paths...> --validator <id>
  opencanon validate --changed
  opencanon validate --project
  opencanon validate --list
  opencanon validate --check-fixtures
  opencanon validate --check-fixtures --validator <id>

Options:
  --format markdown|json   Output format. Default: markdown.
  --files <paths...>       Validate files.
  --changed                Validate changed Git files.
  --project                Run validators across the full project.
  --topic <topic>          Run validators for a topic.
  --validator <id>         Run one validator.
  --fix [safe|suggested|all]
                            Apply structured fixes. Default with --fix: safe.
  --dry-run                Show selected fixes without writing files.
  --strict-warnings        Exit nonzero when warnings are present.
  --require-producer <langs>  Fail unless this result used ready named type producers (comma-separated, e.g. typescript).
  --strict-producers       Escalate every validator producer skip to an error.
  --profile                Show validation timing breakdown.
  --check-fixtures         Validate validator fixtures. Combine with --validator or --topic to filter.
`);
}
