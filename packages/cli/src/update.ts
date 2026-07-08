import { cac } from "cac";
import { applyRuntimeUpdate, checkRuntimeUpdate, type RuntimeUpdateApplyResult, type RuntimeUpdateCheck, type UpdateSafetyGuard } from "@opencanon/distribution";
import { createOpenCanonDiagnostic, fail, Format, OpenCanonError } from "@opencanon/core";
import { inspectAllRuntimes, inspectService, RuntimeStatus } from "@opencanon/runtime";
import { CliOptionDescription, CliOptionFlag, CliOptionName, booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";

const RuntimeManifestEnv = "OPENCANON_UPDATE_MANIFEST";
const DefaultRuntimeManifest = {
  protocol: "https:",
  hostname: "github.com",
  owner: "nick-vi",
  repository: "opencanon",
  assetPath: ["releases", "latest", "download", "opencanon-runtime-manifest.json"],
} as const;
const RuntimeUpdateDiagnosticCode = {
  Failed: "runtime-update-failed",
} as const;

type UpdateQuery = {
  format: Format;
  manifestSource: string;
};

type UpdateApplyQuery = UpdateQuery & {
  dryRun: boolean;
};

export async function runUpdateCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "check", ...rest] = args;
  if (command === "check") {
    await runUpdateCheckCommand(rest, cwd);
    return;
  }
  if (command === "apply") {
    await runUpdateApplyCommand(rest, cwd);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printUpdateHelp();
    return;
  }
  fail(`Unknown update command: ${command}`);
}

async function runUpdateCheckCommand(args: string[], cwd: string): Promise<void> {
  const query = parseUpdateArgs("opencanon update check", args);
  if (!query) return;
  const check = await checkRuntimeUpdate({ manifestSource: query.manifestSource, cwd });
  if (query.format === Format.Json) console.log(JSON.stringify(check, null, 2));
  else console.log(renderRuntimeUpdateCheckMarkdown(check));
}

async function runUpdateApplyCommand(args: string[], cwd: string): Promise<void> {
  const query = parseUpdateApplyArgs(args);
  if (!query) return;
  const result = await applyRuntimeUpdate({ manifestSource: query.manifestSource, cwd, dryRun: query.dryRun, safety: createRuntimeUpdateSafetyGuard() });
  if (query.format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderRuntimeUpdateApplyMarkdown(result));
}

export function createRuntimeUpdateSafetyGuard(): UpdateSafetyGuard {
  return {
    async assertSafeToUpdate() {
      await assertNoRunningRuntimeProcesses();
    },
  };
}

async function assertNoRunningRuntimeProcesses(): Promise<void> {
  const service = await inspectService();
  const runtimes = await inspectAllRuntimes();
  const blockingRuntimes = runtimes.filter((inspection) => inspection.status !== RuntimeStatus.Stale);
  const details: string[] = [];

  if (service && service.status !== RuntimeStatus.Stale) {
    details.push(`Service status: ${service.status}.`);
    details.push(`Service PID: ${service.entry.pid}.`);
  }

  for (const inspection of blockingRuntimes) {
    details.push(`Project runtime status: ${inspection.status}; PID: ${inspection.entry.pid}; root: ${inspection.entry.rootDir}.`);
  }

  if (details.length === 0) return;

  throw new OpenCanonError([
    createOpenCanonDiagnostic({
      code: RuntimeUpdateDiagnosticCode.Failed,
      message: "OpenCanon runtime update requires all OpenCanon processes to be stopped.",
      details,
      action: "Run opencanon service stop, confirm opencanon project list is clear, then rerun the update.",
    }),
  ]);
}

function parseUpdateArgs(commandName: string, args: string[]): UpdateQuery | null {
  const cli = cac(commandName);
  cli.option(CliOptionFlag.Help, "Show help.");
  cli.option(CliOptionFlag.Manifest, CliOptionDescription.RuntimeManifest);
  cli.option(CliOptionFlag.Format, CliOptionDescription.Format);
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [CliOptionName.Help, CliOptionName.H, CliOptionName.Manifest, CliOptionName.Format]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    printUpdateHelp();
    return null;
  }
  if (parsed.args.length > 0) fail(`Unexpected update arguments: ${parsed.args.join(", ")}`);
  return {
    format: formatOption(options.format),
    manifestSource: manifestSourceOption(options.manifest),
  };
}

function parseUpdateApplyArgs(args: string[]): UpdateApplyQuery | null {
  const cli = cac("opencanon update apply");
  cli.option(CliOptionFlag.Help, "Show help.");
  cli.option(CliOptionFlag.Manifest, CliOptionDescription.RuntimeManifest);
  cli.option(CliOptionFlag.Format, CliOptionDescription.Format);
  cli.option(CliOptionFlag.DryRun, "Show the selected runtime asset without writing it.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [CliOptionName.Help, CliOptionName.H, CliOptionName.Manifest, CliOptionName.Format, CliOptionName.DryRun]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    printUpdateHelp();
    return null;
  }
  if (parsed.args.length > 0) fail(`Unexpected update arguments: ${parsed.args.join(", ")}`);
  return {
    format: formatOption(options.format),
    manifestSource: manifestSourceOption(options.manifest),
    dryRun: booleanOption(options.dryRun),
  };
}

function manifestSourceOption(value: unknown): string {
  const values = stringValues(value);
  if (values.length > 1) fail("--manifest accepts one source.");
  const source = values[0] ?? process.env[RuntimeManifestEnv];
  return source ?? defaultRuntimeManifestSource();
}

function defaultRuntimeManifestSource(): string {
  const url = new URL(
    `/${DefaultRuntimeManifest.owner}/${DefaultRuntimeManifest.repository}/${DefaultRuntimeManifest.assetPath.join("/")}`,
    `${DefaultRuntimeManifest.protocol}//${DefaultRuntimeManifest.hostname}`,
  );
  return url.href;
}

function renderRuntimeUpdateCheckMarkdown(check: RuntimeUpdateCheck): string {
  return [
    "# OpenCanon Runtime Update",
    "",
    `Status: ${check.status}`,
    `Target: ${check.target}`,
    `Channel: ${check.channel}`,
    `Runtime version: ${check.runtimeVersion}`,
    `Required Node: ${check.requiredNode}`,
    `Manifest: ${check.manifestSource}`,
    `Bundle: ${check.resolvedBundleSource}`,
    `Runtime root: ${check.runtimeRoot}`,
    `Engine file: ${check.runtimePath}`,
    `Expected bundle SHA-256: ${check.expectedSha256}`,
    check.currentSha256 ? `Installed bundle SHA-256: ${check.currentSha256}` : "Installed bundle SHA-256: <missing>",
  ]
    .filter(Boolean)
    .join("\n");
}

export function renderRuntimeUpdateApplyMarkdown(result: RuntimeUpdateApplyResult): string {
  const lines = [renderRuntimeUpdateCheckMarkdown(result.check), "", `Apply: ${result.status}`];
  if (result.projectActions.length > 0) {
    lines.push("", "Project actions:");
    for (const action of result.projectActions) lines.push(`- ${action.title}: run \`${action.command}\` in initialized projects. ${action.reason}`);
  }
  return lines.join("\n");
}

function printUpdateHelp(): void {
  console.log(`Usage:
  opencanon update check
  opencanon update apply
  opencanon update check --manifest <path-or-url>
  opencanon update apply --manifest <path-or-url> --dry-run

Options:
  ${CliOptionFlag.Manifest}       ${CliOptionDescription.RuntimeManifest}
  ${CliOptionFlag.Format}    Output format. Default: markdown.
  ${CliOptionFlag.DryRun}                 For apply: verify selection without writing the engine binary.

Environment:
  ${RuntimeManifestEnv}      Default manifest source when --manifest is omitted.
  OPENCANON_RUNTIME_ROOT     Override runtime install root.

Default manifest:
  ${defaultRuntimeManifestSource()}
`);
}
