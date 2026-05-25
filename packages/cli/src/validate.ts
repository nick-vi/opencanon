import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import type { DaemonSnapshot } from "@opencanon/daemon";
import { booleanOption, fixModeOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadValidators } from "./project.ts";
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
  listFiles,
  loadCommitApprovalsWithDiagnostics,
  loadContextFiles,
  loadImpactSurfaces,
  matchesProjectFileScope,
  toPendingCommitGates,
  relative,
  resolveCommitGates,
  resolveRootDir,
  savePendingCommitGates,
  splitList,
  toRepoRelativePath,
  unique,
  validateConfig,
  validateContext,
} from "@opencanon/core";
import type { Format } from "@opencanon/core";
import { applyFindingFixes } from "@opencanon/core";
import type { FixMode } from "@opencanon/core";
import { createProfiler, renderProfileMarkdown } from "@opencanon/core";
import type { Profiler } from "@opencanon/core";
import type { Finding, Validator } from "@opencanon/core";
import { createRuntime, createValidationContextFromFixture, createValidationContextFromFixtureFile, flushValidationContextCache, validateFindings } from "@opencanon/core";
import type { ValidationResult } from "@opencanon/core";
import type { ResolvedCommitGate } from "@opencanon/core";
import { selectValidators } from "@opencanon/core";
import { DaemonApiRoute, withDaemonClient } from "./daemon-client.ts";

type Query = {
  files: string[];
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
  help: boolean;
};

let rootDir = "";
let paths: ReturnType<typeof createPaths>;

export async function runValidateCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  rootDir = resolveRootDir(cwd);
  paths = createPaths(rootDir);
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  assertValidConfig(paths);
  resolveChangedFiles(query);

  if (query.list) {
    const snapshot = await withDaemonClient(cwd, (client) => client.get<DaemonSnapshot>(DaemonApiRoute.Snapshot));
    const rows = snapshot.validators.map((validator) => ({
      id: validator.id,
      severity: validator.severity,
      summary: validator.summary,
      topics: validator.topics,
      applies: validator.appliesScopes.length === 0 ? ["<project>"] : validator.appliesScopes.map((patterns) => patterns.join(" && ")),
      decisionIds: validator.decisionIds ?? [],
      docs: validator.docs ?? [],
    }));
    if (query.format === "json") writeJson({ validators: rows });
    else console.log(rows.map((row) => `- ${row.id} (${row.severity}) topics=${row.topics.join(",")}${row.summary ? ` summary=${row.summary}` : ""}`).join("\n"));
    return;
  }

  if (query.checkFixtures) {
    const profiler = createProfiler(query.profile);
    const { decisions } = profiler.measure("load.context", () => loadContextFiles(paths));
    const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = profiler.measure("load.impact", () => loadImpactSurfaces(paths));
    const validators = await profiler.measureAsync("load.validators", () => loadValidators(rootDir, paths));
    const diagnostics = [...impactDiagnostics, ...validateContext({ decisions, validators, impactSurfaces, paths })];
    if (diagnostics.length > 0) {
      console.error("OpenCanon files are invalid. Run bun run opencanon context --check for details.");
      process.exit(1);
    }
    if (query.checkFixtures) {
      const fixtureValidators = selectValidators(validators, {
        topics: query.topics,
        validatorIds: query.validatorIds,
      });
      const result = await profiler.measureAsync("fixtures.check", () => checkFixtures(fixtureValidators, createRuntime(paths, decisions), profiler));
      if (query.format === "json") {
        writeJson({ ...result, profile: query.profile ? profiler.entries() : undefined });
      } else {
        console.log(renderFixtureResult(result));
        if (query.profile) console.log(`\n${renderProfileMarkdown(profiler.entries())}`);
      }
      process.exit(result.failed === 0 ? 0 : 1);
    }
  }

  if (query.changed && query.files.length === 0) {
    console.log("No changed files.");
    return;
  }

  if (!query.project && query.files.length === 0) {
    printHelp();
    process.exit(1);
  }

  let result = await withDaemonClient(cwd, (client) =>
    client.post<ValidationResult>(DaemonApiRoute.Validate, {
      files: query.files,
      topics: query.topics,
      validatorIds: query.validatorIds,
      project: query.project,
      fixMode: query.fixMode,
      dryRun: query.dryRun,
      profile: query.profile,
    }),
  );
  result = query.changed ? resolveValidationCommitGates(result, true) : { ...result, commitGates: [] };

  if (query.format === "json") writeJson(result);
  else console.log(renderFindings(result));
  process.exit(validationExitCode(result, query));
}

function validationExitCode(result: ValidationResult, query: Pick<Query, "changed" | "strictWarnings">): number {
  if (result.diagnostics.length > 0 || result.fixes?.diagnostics.length) return 1;
  if (result.findings.some((finding) => finding.severity === "error")) return 1;
  if (query.changed && (result.commitGates ?? []).some((gate) => gate.status !== "approved")) return 1;
  if (query.strictWarnings && result.findings.some((finding) => finding.severity === "warning")) return 1;
  return 0;
}

function assertValidConfig(paths: ReturnType<typeof createPaths>): void {
  const diagnostics = validateConfig(paths);
  if (diagnostics.length === 0) return;
  console.error("OpenCanon config is invalid:\n");
  for (const diagnostic of diagnostics) console.error(`- ${diagnostic}`);
  process.exit(1);
}

function parseArgs(args: string[]): Query {
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
    "format",
    "topic",
    "topics",
    "validator",
    "files",
  ]);

  const query: Query = {
    files: unique([...stringValues(options.files), ...parsed.args.map(String)].map((file) => toRepoRelativePath(rootDir, file))),
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
    help: booleanOption(options.help) || booleanOption(options.h),
  };
  return query;
}

function resolveChangedFiles(query: Query): void {
  if (!query.changed) return;
  const result = getChangedFiles(rootDir);
  if (!result.gitRoot) fail(result.diagnostics.join("\n"));
  query.files = unique([...query.files, ...result.files.filter((file) => matchesProjectFileScope(paths, file))]);
}

async function checkFixtures(validators: Validator[], runtime = createRuntime(paths, []), profiler = createProfiler(false)) {
  const checks: Array<{ validatorId: string; case: "valid" | "invalid" | "fixed"; file: string; passed: boolean; findings: Finding[]; details?: string[] }> = [];
  const findingValidationContext = {
    paths,
    decisionIds: new Set(runtime.decisions.all.map((decision) => decision.id)),
  };

  for (const validator of validators) {
    for (const fixtureCase of ["valid", "invalid"] as const) {
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
        passed: (fixtureCase === "valid" ? findings.length === 0 : findings.length > 0) && details.length === 0,
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
      if (gate.decisionIds && gate.decisionIds.length > 0) lines.push(`  Decisions: ${gate.decisionIds.join(", ")}`);
      if (gate.impactSurfaceIds && gate.impactSurfaceIds.length > 0) lines.push(`  Impact surfaces: ${gate.impactSurfaceIds.join(", ")}`);
      for (const evidence of gate.evidence ?? []) {
        const location = evidence.file ? `${evidence.file}${evidence.line ? `:${evidence.line}` : ""}` : "";
        lines.push(`  Evidence: ${[location, evidence.message].filter(Boolean).join(" ")}`);
      }
      lines.push(`  Record after explicit user approval: bun run opencanon gate approve ${gate.id} --summary "<user explicit answer to the gate question>" --via agent`);
    }
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
        },
        null,
        2,
      ),
    );
    lines.push("```");
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
    if (finding.decisionIds && finding.decisionIds.length > 0) lines.push(`  Decisions: ${finding.decisionIds.join(", ")}`);
    if (finding.docs && finding.docs.length > 0) lines.push(`  Docs: ${finding.docs.join(", ")}`);
  }
  if (result.findings.length > 0) {
    lines.push("");
    lines.push("Finding Resolution Policy:");
    lines.push("- Any finding must be addressed before the agent completes the task.");
    lines.push("- Fix code to match the current decision whenever the finding is valid.");
    lines.push("- If the validator is wrong, fix the validator and add or update valid/invalid fixtures.");
    lines.push("- If the convention itself changed, ask the user before editing decisions with this template:");
    lines.push("");
    lines.push("```text");
    lines.push("Decision update needed");
    lines.push("Finding: <validator-id> at <file:line>");
    lines.push("Current decision: <decision-id or topic>");
    lines.push("Why current canon does not fit: <short reason>");
    lines.push("Proposed new required pattern: <specific rule>");
    lines.push("Code impact: <files/layers affected>");
    lines.push("Validator impact: <validators/fixtures to update>");
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
    lines.push("bun run opencanon context --list-exceptions");
    lines.push("```");
  }
  if (result.profile) {
    lines.push("");
    lines.push(renderProfileMarkdown(result.profile));
  }
  return lines.join("\n");
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
  return !relativeFile.includes("/.opencanon/") && /\.(ts|tsx|js|jsx|py|rs|svelte|css|scss|sass|less|json|md|markdown)$/.test(file);
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function printHelp(): void {
  console.log(`Usage:
  bun run opencanon validate --files <paths...>
  bun run opencanon validate --files <paths...> --topic <topic>
  bun run opencanon validate --files <paths...> --validator <id>
  bun run opencanon validate --changed
  bun run opencanon validate --project
  bun run opencanon validate --list
  bun run opencanon validate --check-fixtures
  bun run opencanon validate --check-fixtures --validator <id>

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
  --profile                Show validation timing breakdown.
  --check-fixtures         Validate validator fixtures. Combine with --validator or --topic to filter.
`);
}
