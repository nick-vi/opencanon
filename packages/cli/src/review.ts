import { cac } from "cac";
import {
  DiagnosticSeverity,
  DoctorStatus,
  Format,
  buildDoctorReport,
  createCommitApprovalContext,
  definitionTargetFiles,
  fail,
  getChangedFiles,
  getCommitGateFiles,
  loadCommitApprovalsWithDiagnostics,
  matchesAny,
  matchesProjectFileScope,
  resolveCommitGates,
  resolveImpactSurfaceConventionsForFiles,
  resolveRootDir,
  type ReadSemanticIndexStatusResult,
  toRepoRelativePath,
  unique,
} from "@opencanon/core";
import type { Change, ContextPaths, DoctorReport, ImpactSurfaceConventionResolution, ProducerStatus, ResolvedCommitGate, ValidationResult } from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";
import { RuntimeApiRoute, fetchRunningRuntimeProducers, withRuntimeClient } from "./runtime-client.ts";
import { validationExitCode } from "./validate.ts";

const ReviewStatusValue = {
  Pass: "pass",
  Warn: "warn",
  Fail: "fail",
} as const;
type ReviewStatus = (typeof ReviewStatusValue)[keyof typeof ReviewStatusValue];

type ReviewQuery = {
  files: string[];
  changed: boolean;
  format: Format;
  runExternalTools: boolean;
  strictWarnings: boolean;
  strictProducers: boolean;
  help: boolean;
};

type ReviewReport = {
  generatedAt: string;
  rootDir: string;
  files: string[];
  doctor: DoctorReport;
  validation: ValidationResult | null;
  impactedSurfaces: Array<{
    id: string;
    title: string;
    files: string[];
    conventionIds: string[];
  }>;
  relatedChanges: Array<{
    id: string;
    title: string;
    kind: string;
    checks: string[];
  }>;
  externalTools: {
    configured: number;
    checked: boolean;
    status: string | null;
    message: string | null;
  };
  status: ReviewStatus;
};

export async function runReviewCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const rootDir = resolveRootDir(cwd);
  const query = parseArgs(args, rootDir);
  if (query.help) {
    printHelp();
    return;
  }

  const project = await loadProjectContext(rootDir);
  const files = resolveReviewFiles(query, rootDir, project.paths);
  const knowledge = await fetchRuntimeKnowledge(rootDir);
  const validation = files.length > 0 ? await validateFilesForReview(rootDir, project.paths, files, query.strictProducers) : null;
  const producerStatuses = await fetchRunningRuntimeProducers<ProducerStatus[]>(rootDir);
  const doctor = buildDoctorReport({
    paths: project.paths,
    areas: project.areas,
    specs: project.specs,
    changes: project.changes,
    conventions: project.conventions,
    validators: project.validators,
    runExternalTools: query.runExternalTools,
    producerStatuses,
    knowledgeInspection: { kind: "available", index: knowledge?.index ?? null },
  });
  const impact = resolveImpactSurfaceConventionsForFiles({
    files,
    impactSurfaces: project.impactSurfaces,
    conventions: project.conventions,
  });
  const report: ReviewReport = {
    generatedAt: new Date().toISOString(),
    rootDir,
    files,
    doctor,
    validation,
    impactedSurfaces: impact.surfaces.map((match) => ({
      id: match.surface.id,
      title: match.surface.title ?? match.surface.id,
      files: match.files,
      conventionIds: match.conventionIds,
    })),
    relatedChanges: relatedChanges(project.changes, files, impact).map((change) => ({
      id: change.id,
      title: change.title,
      kind: change.kind,
      checks: (change.checks ?? []).map((check) => check.id),
    })),
    externalTools: externalToolSummary(doctor, query.runExternalTools, Object.keys(project.paths.externalTools ?? {}).length),
    status: reviewStatus(doctor, validation, query),
  };

  if (query.format === Format.Json) console.log(JSON.stringify(report, null, 2));
  else console.log(renderReviewMarkdown(report));

  process.exit(report.status === ReviewStatusValue.Fail ? 1 : 0);
}

function parseArgs(args: string[], rootDir: string): ReviewQuery {
  const cli = cac("opencanon review");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--files <path>", "Review explicit repository files.");
  cli.option("--changed", "Review changed Git files. Default when --files is omitted.");
  cli.option("--run-external-tools", "Execute configured external tool checks through Doctor.");
  cli.option("--strict-warnings", "Exit nonzero when warnings are present.");
  cli.option("--strict-producers", "Escalate validator producer skips to errors.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "files", "changed", "runExternalTools", "strictWarnings", "strictProducers"]);
  const explicitFiles = unique([...stringValues(options.files), ...parsed.args.map(String)].map((file) => toRepoRelativePath(rootDir, file)));

  return {
    files: explicitFiles,
    changed: booleanOption(options.changed) || explicitFiles.length === 0,
    format: formatOption(options.format),
    runExternalTools: booleanOption(options.runExternalTools),
    strictWarnings: booleanOption(options.strictWarnings),
    strictProducers: booleanOption(options.strictProducers),
    help: booleanOption(options.help) || booleanOption(options.h),
  };
}

function resolveReviewFiles(query: ReviewQuery, rootDir: string, paths: ContextPaths): string[] {
  const files = [...query.files];
  if (query.changed) {
    const result = getChangedFiles(rootDir);
    if (!result.gitRoot) fail(result.diagnostics.join("\n"));
    files.push(...result.files.filter((file) => matchesProjectFileScope(paths, file)));
  }
  return unique(files.filter((file) => matchesProjectFileScope(paths, file))).sort();
}

async function fetchRuntimeKnowledge(rootDir: string): Promise<ReadSemanticIndexStatusResult | null> {
  try {
    return await withRuntimeClient<ReadSemanticIndexStatusResult>(rootDir, (client) => client.get(RuntimeApiRoute.ContextStatus));
  } catch {
    return null;
  }
}

async function validateFilesForReview(rootDir: string, paths: ContextPaths, files: string[], strictProducers: boolean): Promise<ValidationResult> {
  const result = await withRuntimeClient<ValidationResult>(
    rootDir,
    (client) =>
      client.post(RuntimeApiRoute.Validate, {
        files,
        topics: [],
        validatorIds: [],
        project: false,
        dryRun: true,
        strictProducers,
      }),
  );
  if ((result.commitGates ?? []).length === 0) return { ...result, commitGates: [] };
  const approvalContext = createCommitApprovalContext(paths, result.validatorGraphHash);
  const approvals = loadCommitApprovalsWithDiagnostics(paths);
  const fileSet = new Set(files);
  const scopedGates = (result.commitGates ?? []).filter((gate) => {
    const gateFiles = getCommitGateFiles(gate);
    return gateFiles.length === 0 || gateFiles.some((file) => fileSet.has(file));
  });
  return {
    ...result,
    diagnostics: [...result.diagnostics, ...approvalContext.diagnostics, ...approvals.diagnostics],
    commitGates: resolveCommitGates(scopedGates, approvals.approvals, approvalContext),
  };
}

function relatedChanges(changes: Change[], files: string[], impact: ImpactSurfaceConventionResolution): Change[] {
  const impactedSurfaceIds = new Set(impact.surfaces.map((match) => match.surface.id));
  return changes
    .filter((change) => {
      if ((change.updates?.surfaces ?? []).some((surfaceId) => impactedSurfaceIds.has(surfaceId))) return true;
      const targetFiles = [...definitionTargetFiles(change.scope), ...(change.tasks ?? []).flatMap((task) => task.files ?? [])];
      if (targetFiles.some((target) => files.some((file) => file === target || matchesAny(file, [target])))) return true;
      return false;
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

function externalToolSummary(doctor: DoctorReport, checked: boolean, configured: number): ReviewReport["externalTools"] {
  const check = doctor.checks.find((item) => item.id === "external-tools");
  return {
    configured,
    checked,
    status: check?.status ?? null,
    message: check?.message ?? null,
  };
}

function reviewStatus(doctor: DoctorReport, validation: ValidationResult | null, query: Pick<ReviewQuery, "strictWarnings" | "strictProducers">): ReviewReport["status"] {
  const validationCode = validation ? validationExitCode(validation, { changed: true, strictWarnings: query.strictWarnings, strictProducers: query.strictProducers }) : 0;
  if (doctor.status === DoctorStatus.Fail || validationCode !== 0) return ReviewStatusValue.Fail;
  if (doctor.status === DoctorStatus.Warn || validationHasWarnings(validation)) return query.strictWarnings ? ReviewStatusValue.Fail : ReviewStatusValue.Warn;
  return ReviewStatusValue.Pass;
}

function validationHasWarnings(validation: ValidationResult | null): boolean {
  return validation?.findings.some((finding) => finding.severity === DiagnosticSeverity.Warning) ?? false;
}

function renderReviewMarkdown(report: ReviewReport): string {
  const lines = ["# OpenCanon Review Report", ""];
  lines.push(`Status: ${report.status}`);
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push(`Project: ${report.rootDir}`);
  lines.push(`Files: ${report.files.length > 0 ? report.files.join(", ") : "none"}`);
  lines.push("");
  lines.push("## Summary");
  lines.push(`- Doctor: ${report.doctor.status}`);
  lines.push(`- Findings: ${report.validation?.findingCount ?? 0}`);
  lines.push(`- Commit gates: ${commitGateCount(report.validation?.commitGates ?? [])}`);
  lines.push(`- Impact surfaces: ${report.impactedSurfaces.length}`);
  lines.push(`- Related Changes: ${report.relatedChanges.length}`);
  lines.push(`- External tools: ${report.externalTools.configured}${report.externalTools.checked ? " checked" : " declared only"}`);
  lines.push("");
  renderImpactedSurfaces(lines, report);
  renderRelatedChanges(lines, report);
  renderValidation(lines, report.validation);
  renderDoctor(lines, report.doctor);
  if (report.externalTools.message) {
    lines.push("## External Tools");
    lines.push(`- [${report.externalTools.status ?? "unknown"}] ${report.externalTools.message}`);
    lines.push("");
  }
  return lines.join("\n");
}

function commitGateCount(gates: Array<ResolvedCommitGate | NonNullable<ValidationResult["commitGates"]>[number]>): string {
  const unresolved = gates.filter((gate) => !("status" in gate) || gate.status !== "approved").length;
  const approved = gates.filter((gate) => "status" in gate && gate.status === "approved").length;
  return `${unresolved} unresolved, ${approved} approved`;
}

function renderImpactedSurfaces(lines: string[], report: ReviewReport): void {
  lines.push("## Impact Surfaces");
  if (report.impactedSurfaces.length === 0) {
    lines.push("- None");
    lines.push("");
    return;
  }
  for (const surface of report.impactedSurfaces) {
    lines.push(`- ${surface.id}: ${surface.title}`);
    lines.push(`  Files: ${surface.files.join(", ")}`);
    if (surface.conventionIds.length > 0) lines.push(`  Conventions: ${surface.conventionIds.join(", ")}`);
  }
  lines.push("");
}

function renderRelatedChanges(lines: string[], report: ReviewReport): void {
  lines.push("## Related Changes");
  if (report.relatedChanges.length === 0) {
    lines.push("- None");
    lines.push("");
    return;
  }
  for (const change of report.relatedChanges) {
    lines.push(`- ${change.id} (${change.kind}): ${change.title}`);
    if (change.checks.length > 0) lines.push(`  Checks: ${change.checks.join(", ")}`);
  }
  lines.push("");
}

function renderValidation(lines: string[], validation: ValidationResult | null): void {
  lines.push("## Validation");
  if (!validation) {
    lines.push("- No files selected.");
    lines.push("");
    return;
  }
  if (validation.diagnostics.length > 0) {
    for (const diagnostic of validation.diagnostics) lines.push(`- diagnostic: ${diagnostic}`);
  }
  if (validation.findings.length === 0) {
    lines.push("- No findings.");
  } else {
    for (const finding of validation.findings) {
      lines.push(`- [${finding.severity}] ${finding.file}:${finding.line} ${finding.validatorId}`);
      lines.push(`  ${finding.message}`);
    }
  }
  for (const gate of validation.commitGates ?? []) {
    const status = "status" in gate ? gate.status : "unresolved";
    lines.push(`- [gate:${status}] ${gate.id} ${gate.title}`);
  }
  lines.push("");
}

function renderDoctor(lines: string[], doctor: DoctorReport): void {
  lines.push("## Doctor");
  const notable = doctor.checks.filter((check) => check.status !== DoctorStatus.Pass);
  if (notable.length === 0) {
    lines.push("- All checks passed.");
    lines.push("");
    return;
  }
  for (const check of notable) {
    lines.push(`- [${check.status}] ${check.id}: ${check.message}`);
    for (const detail of check.details ?? []) lines.push(`  ${detail}`);
  }
  lines.push("");
}

function printHelp(): void {
  console.log(`Usage:
  opencanon review
  opencanon review --files <paths...>
  opencanon review --format json

Options:
  --format markdown|json    Output format. Default: markdown.
  --files <paths...>        Review explicit files instead of only changed Git files.
  --changed                 Include changed Git files. Default when no --files are provided.
  --run-external-tools      Execute configured external tool checks.
  --strict-warnings         Exit nonzero when warnings are present.
  --strict-producers        Escalate validator producer skips to errors.
`);
}
