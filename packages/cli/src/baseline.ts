import { mkdirSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import {
  createPaths,
  createProfiler,
  BatchProducerPolicy,
  fail,
  Format,
  loadBaseline,
  relative,
  resolveRootDir,
  runValidation,
  validateConfig,
  writeAtomicJsonFileSync,
  type Baseline,
} from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions } from "./options.ts";
import { loadProjectContext } from "./project.ts";

export async function runBaselineCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "check", ...rest] = args;
  if (command === "check") {
    runBaselineCheckCommand(rest, cwd);
    return;
  }
  if (command === "update") {
    await runBaselineUpdateCommand(rest, cwd);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printBaselineHelp();
    return;
  }
  fail(`Unknown baseline command: ${command}`);
}

function runBaselineCheckCommand(args: string[], cwd: string): void {
  const cli = cac("opencanon baseline check");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printBaselineHelp();
    return;
  }
  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const baseline = loadBaseline(paths);
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(baseline, null, 2));
  else console.log(`# OpenCanon Baseline\n\nPath: ${relative(rootDir, paths.baselinePath)}\nFindings: ${baseline.findings.length}`);
}

async function runBaselineUpdateCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon baseline update");
  cli.option("-h, --help", "Show help.");
  cli.option("--dry-run", "Show baseline without writing.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "dryRun", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printBaselineHelp();
    return;
  }
  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const configDiagnostics = validateConfig(paths);
  if (configDiagnostics.length > 0) fail(configDiagnostics.join("\n"));
  const { conventions, validators } = await loadProjectContext(cwd);
  const result = await runValidation({
    rootDir,
    paths,
    conventions,
    validators,
    project: true,
    profiler: createProfiler(false),
    producerPolicy: BatchProducerPolicy,
  });
  const baseline: Baseline = {
    version: 1,
    findings: result.findings.map((finding) => ({
      key: [finding.validatorId, finding.file, finding.line, finding.message].join("\u0000"),
      validatorId: finding.validatorId,
      file: finding.file,
      line: finding.line,
      message: finding.message,
    })),
  };
  if (!booleanOption(options.dryRun)) {
    mkdirSync(path.dirname(paths.baselinePath), { recursive: true });
    writeAtomicJsonFileSync(paths.baselinePath, baseline);
  }
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(baseline, null, 2));
  else console.log(`# OpenCanon Baseline\n\n${booleanOption(options.dryRun) ? "Dry run: yes\n" : ""}Findings: ${baseline.findings.length}`);
}

function printBaselineHelp(): void {
  console.log(`Usage:
  opencanon baseline check
  opencanon baseline update

Commands:
  check   Show baseline status.
  update  Rebuild the baseline from current project validation findings.
`);
}
