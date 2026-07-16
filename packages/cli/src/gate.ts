import { cac } from "cac";
import type { ValidationResult } from "@opencanon/core";
import {
  createCommitApprovalContext,
  createCommitApprovalRecord,
  createPaths,
  fail,
  getGitRoot,
  loadCommitApprovalsWithDiagnostics,
  loadPendingCommitGates,
  matchesProjectFileScope,
  resolveCommitGates,
  resolveRootDir,
  saveCommitApprovals,
  savePendingCommitGates,
  unique,
  upsertCommitApproval,
  validateConfig,
} from "@opencanon/core";
import type { ResolvedCommitGate } from "@opencanon/core";
import { Format } from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { withRuntimeClient } from "./runtime-client.ts";

export async function runGateCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "help", ...rest] = args;
  if (command === "approve") {
    await runGateApproveCommand(rest, cwd);
    return;
  }
  if (command === "pending") {
    runGatePendingCommand(rest, cwd);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printGateHelp();
    return;
  }
  fail(`Unknown gate command: ${command}`);
}

async function runGateApproveCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon gate approve");
  cli.option("-h, --help", "Show help.");
  cli.option("--summary <summary>", "User clarification summary.");
  cli.option("--by <name>", "Approver name. Defaults to the current user.");
  cli.option("--via <via>", "Approval source: cli, agent, or manual.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "summary", "by", "via"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printGateHelp();
    return;
  }

  const gateId = String(parsed.args[0] ?? "").trim();
  const summary = singleOption(options.summary, "--summary").trim();
  const approvedBy = singleOption(options.by, "--by", "").trim() || undefined;
  const approvedVia = parseApprovedVia(singleOption(options.via, "--via", "cli").trim());
  if (!gateId) fail("Gate id is required.");
  if (!summary) fail("--summary is required and must describe what the user clarified.");

  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const configDiagnostics = validateConfig(paths);
  if (configDiagnostics.length > 0) fail(configDiagnostics.join("\n"));
  const { approvalContext, approvals, gates, governingConventions } = await currentCommitGates(cwd, rootDir, paths);
  const matchingGates = gates.filter((item) => item.id === gateId);
  if (matchingGates.length > 1) fail(`Commit gate id is ambiguous: ${gateId}. Gate ids must be unique for approval.`);
  const gate = matchingGates[0];
  if (!gate) fail(`No current commit gate found with id: ${gateId}`);
  if (gate.status === "approved") {
    console.log(`Commit gate already approved for current diff: ${gateId}`);
    return;
  }

  const record = createCommitApprovalRecord({
    gate,
    summary,
    approvedBy,
    approvedVia,
    context: approvalContext,
  });
  const updatedApprovals = upsertCommitApproval(approvals, record);
  saveCommitApprovals(paths, updatedApprovals);
  savePendingCommitGates(paths, {
    context: approvalContext,
    gates: resolveCommitGates(gates, updatedApprovals, approvalContext),
    governingConventions,
  });

  console.log(`Approved commit gate for current diff: ${gateId}`);
}

function runGatePendingCommand(args: string[], cwd: string): void {
  const cli = cac("opencanon gate pending");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printGateHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected gate pending arguments: ${parsed.args.join(", ")}`);
  const format = formatOption(options.format);
  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const pending = loadPendingCommitGates(paths);
  if (format === Format.Json) {
    console.log(JSON.stringify(pending, null, 2));
    return;
  }
  console.log(renderPendingMarkdown(pending, format));
}

async function currentCommitGates(cwd: string, rootDir: string, paths: ReturnType<typeof createPaths>): Promise<{
  approvalContext: ReturnType<typeof createCommitApprovalContext>;
  approvals: ReturnType<typeof loadCommitApprovalsWithDiagnostics>["approvals"];
  gates: ResolvedCommitGate[];
  governingConventions: ValidationResult["governingConventions"];
}> {
  if (!getGitRoot(rootDir)) fail(`Not a git repository: ${rootDir}`);
  const pendingContext = createCommitApprovalContext(paths, "pending");
  const files = unique(pendingContext.stagedFiles.filter((file) => matchesProjectFileScope(paths, file)));
  if (files.length === 0) fail("No changed project files are available for commit gate approval.");

  const result = await withRuntimeClient(cwd, (client) =>
    client.query<ValidationResult>("validation.run", {
      body: { files, topics: [], validatorIds: [], project: false },
    }),
  );
  const approvalContext = createCommitApprovalContext(paths, result.validatorGraphHash);
  const approvals = loadCommitApprovalsWithDiagnostics(paths);
  if (approvals.diagnostics.length > 0) fail(approvals.diagnostics.join("\n"));
  const gates = resolveCommitGates(result.commitGates ?? [], approvals.approvals, approvalContext);
  savePendingCommitGates(paths, {
    context: approvalContext,
    gates,
    diagnostics: [...approvalContext.diagnostics, ...approvals.diagnostics],
    governingConventions: result.governingConventions,
  });
  return { approvalContext, approvals: approvals.approvals, gates, governingConventions: result.governingConventions };
}

function renderPendingMarkdown(pending: ReturnType<typeof loadPendingCommitGates>, _format: Format): string {
  const lines = ["# Pending Commit Gates", "", `Pending: ${pending.pending.length}`, `Approved: ${pending.approved.length}`];
  if (pending.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of pending.diagnostics) lines.push(`- ${diagnostic}`);
  }
  if (pending.pending.length > 0) {
    lines.push("");
    if (pending.governingConventions && pending.governingConventions.conventions.length > 0) {
      lines.push("Governing Conventions:");
      for (const convention of pending.governingConventions.conventions) {
        lines.push(`- ${convention.id}: ${convention.title}`);
        lines.push(`  Rule: ${convention.rule}`);
        if (convention.docs.length > 0) lines.push(`  Docs: ${convention.docs.join(", ")}`);
        if (convention.impactSurfaceIds.length > 0) lines.push(`  Impact surfaces: ${convention.impactSurfaceIds.join(", ")}`);
      }
      if (pending.governingConventions.truncated) {
        lines.push(`- ${pending.governingConventions.omittedConventions} more relevant convention(s) omitted from pending-gate feedback.`);
      }
      lines.push("");
    }
    for (const gate of pending.pending) {
      lines.push(`- ${gate.id} (${gate.validatorId})`);
      lines.push(`  Question: ${gate.question}`);
      lines.push(`  Reason: ${gate.reason}`);
      if (gate.file) lines.push(`  File: ${gate.file}${gate.line ? `:${gate.line}` : ""}`);
      lines.push("  Agent action: request structured user input.");
      lines.push(`  Preferred tools: ${gate.preferredToolNames.join(", ")}`);
      lines.push(`  Plain chat fallback: ${gate.fallbackProtocol}`);
      for (const instruction of gate.agentProtocol) lines.push(`  - ${instruction}`);
      lines.push("  Choices:");
      for (const choice of gate.choices) lines.push(`  - ${choice.label}: ${choice.description}`);
      lines.push(`  Approve: ${gate.approveCommand}`);
    }
  }
  return lines.join("\n");
}

function parseApprovedVia(value: string): "cli" | "agent" | "manual" {
  if (value === "cli" || value === "agent" || value === "manual") return value;
  fail("--via must be cli, agent, or manual.");
}

function singleOption(value: unknown, flag: string, fallback?: string): string {
  const values = stringValues(value);
  if (values.length === 0 && fallback !== undefined) return fallback;
  if (values.length !== 1) fail(`${flag} requires one value.`);
  return values[0] ?? "";
}

function printGateHelp(): void {
  console.log(`Usage:
  opencanon gate approve <gate-id> --summary <summary>
  opencanon gate pending [--format json]

Commands:
  approve  Record user clarification for the current Git diff.
  pending  Show unresolved gates from the last changed-file validation.
`);
}
