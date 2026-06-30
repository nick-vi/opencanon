import { existsSync, readFileSync } from "node:fs";
import { cac } from "cac";
import {
  DefinitionTargetKind,
  SpecCheckKind,
  SpecRenderKind,
  SpecRenderStyle,
  buildDefinitionDiffGitArgs,
  buildDefinitionHistoryGitArgs,
  buildDefinitionVersionsGitArgs,
  buildRelatedDefinitionCommitsGitArgs,
  dedupeCommits,
  fail,
  Format,
  loadSpecHistoryTarget,
  parseConventionGitLog,
  relative,
  renderSpec,
  resolveSpecGeneratedDocsPath,
  runGit,
  type ConventionHistoryCommit,
  type SpecHistoryTarget,
  type SpecRule,
  type SpecScenario,
  writeAtomicTextFileSync,
} from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";

type RenderAction = "unchanged" | "written" | "would-write";

type RenderedSpecFile = {
  id: string;
  path: string;
  style: string;
  action: RenderAction;
};

type RenderSpecsResult = {
  dryRun: boolean;
  generated: number;
  changed: number;
  files: RenderedSpecFile[];
};

type SpecListResult = {
  specs: Array<{
    id: string;
    title: string;
    render: string;
    docs?: string;
    checks: number;
    rules: number;
    scenarios: number;
    surfaces: string[];
    areas: string[];
    conventions: string[];
  }>;
};

type SpecLogResult = {
  command: "history" | "related-commits" | "versions";
  target: SpecHistoryTarget;
  commits: ConventionHistoryCommit[];
};

type SpecDiffResult = {
  command: "diff";
  target: SpecHistoryTarget;
  from: string;
  to: string;
  diff: string;
};

type SpecDraftResult = {
  id: string;
  source: string;
  nextCommands: string[];
};

export async function runSpecsCommand(args: string[], cwd: string): Promise<void> {
  const [command = "list", ...rest] = args;
  if (command === "-h" || command === "--help" || command === "help") {
    printSpecsHelp();
    return;
  }
  if (command === "list") {
    await runSpecsListCommand(rest, cwd);
    return;
  }
  if (command === "render") {
    await runSpecsRenderCommand(rest, cwd);
    return;
  }
  if (command === "draft") {
    runSpecsDraftCommand(rest);
    return;
  }
  if (command === "history") {
    await runSpecsHistoryCommand(rest, cwd);
    return;
  }
  if (command === "diff") {
    await runSpecsDiffCommand(rest, cwd);
    return;
  }
  if (command === "related-commits") {
    await runSpecsRelatedCommitsCommand(rest, cwd);
    return;
  }
  if (command === "versions") {
    await runSpecsVersionsCommand(rest, cwd);
    return;
  }
  fail(`Unknown specs command: ${command}`);
}

async function runSpecsListCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon list specs");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSpecsHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected canon list specs arguments: ${parsed.args.join(", ")}`);

  const project = await loadProjectContext(cwd);
  const result: SpecListResult = {
    specs: project.specs
      .map((spec) => ({
        id: spec.id,
        title: spec.title,
        render: spec.render.kind,
        docs: spec.render.kind === SpecRenderKind.None ? undefined : spec.render.docs,
        checks: spec.checks?.length ?? 0,
        rules: spec.rules?.length ?? 0,
        scenarios: spec.scenarios?.length ?? 0,
        surfaces: spec.surfaces ?? [],
        areas: spec.areas ?? [],
        conventions: spec.governedBy?.conventions ?? [],
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };

  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderSpecsListMarkdown(result));
}

async function runSpecsRenderCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon render specs");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--dry-run", "Show generated docs that would change without writing files.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "dryRun"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSpecsHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected canon render specs arguments: ${parsed.args.join(", ")}`);

  const result = await renderGeneratedSpecs(cwd, { dryRun: booleanOption(options.dryRun) });
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderSpecsMarkdown(result));
}

function runSpecsDraftCommand(args: string[]): void {
  const cli = cac("opencanon canon draft spec");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--title <title>", "Spec title.");
  cli.option("--summary <summary>", "Spec summary.");
  cli.option("--file <glob>", "Scoped file or glob. Repeatable.");
  cli.option("--doc <path>", "Scoped doc path. Repeatable.");
  cli.option("--surface <id>", "Impact surface id. Repeatable.");
  cli.option("--area <id>", "Linked area id. Repeatable.");
  cli.option("--convention <id>", "Governing convention id. Repeatable.");
  cli.option("--infer-conventions", "Infer governing conventions from scope.");
  cli.option("--depends-on <id>", "Spec dependency id. Repeatable.");
  cli.option("--rule <id=statement>", "Rule statement. Repeatable.");
  cli.option("--acceptance <rule-id=text>", "Acceptance item for a rule. Repeatable.");
  cli.option("--scenario <id=given;given|when|then;then>", "User scenario. Repeatable.");
  cli.option("--check-command <id=command>", "Command check. Repeatable.");
  cli.option("--check-doctor <id>", "Doctor check id. Repeatable.");
  cli.option("--check-validator <id=validator-id>", "Validator-backed check. Repeatable.");
  cli.option("--check-test <id=target>", "Test-backed check. Repeatable.");
  cli.option("--render <kind>", "Render kind: generated or none. Default: generated when --docs is set, otherwise none.");
  cli.option("--docs <path>", "Generated docs path.");
  cli.option("--style <style>", "Generated docs render style. Default: reference.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [
    "help",
    "h",
    "format",
    "title",
    "summary",
    "file",
    "doc",
    "surface",
    "area",
    "convention",
    "inferConventions",
    "dependsOn",
    "rule",
    "acceptance",
    "scenario",
    "checkCommand",
    "checkDoctor",
    "checkValidator",
    "checkTest",
    "render",
    "docs",
    "style",
  ]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSpecsHelp();
    return;
  }

  const id = requiredSingleArgument(parsed.args, "canon draft spec");
  const title = requiredStringOption(options.title, "--title");
  const summary = requiredStringOption(options.summary, "--summary");
  const docs = stringOptionOptional(options.docs, "--docs");
  const renderKind = renderKindOption(options.render, docs);
  const style = specRenderStyleOption(options.style);
  const scope = [
    ...stringValues(options.file).map((file) => ({ kind: DefinitionTargetKind.File, path: file })),
    ...stringValues(options.doc).map((doc) => ({ kind: DefinitionTargetKind.Doc, path: doc })),
  ];
  const checks = [
    ...stringValues(options.checkCommand).map(parseCommandCheck),
    ...stringValues(options.checkDoctor).map(parseDoctorCheck),
    ...stringValues(options.checkValidator).map(parseValidatorCheck),
    ...stringValues(options.checkTest).map(parseTestCheck),
  ];
  const rules = attachAcceptanceItems(stringValues(options.rule).map(parseRule), stringValues(options.acceptance));
  const scenarios = stringValues(options.scenario).map(parseScenario);
  const conventions = stringValues(options.convention);
  const definition: Record<string, unknown> = {
    id,
    title,
    summary,
  };
  const surfaces = stringValues(options.surface);
  const areas = stringValues(options.area);
  const dependencies = stringValues(options.dependsOn);
  if (scope.length > 0) definition.scope = scope;
  if (surfaces.length > 0) definition.surfaces = surfaces;
  if (areas.length > 0) definition.areas = areas;
  if (dependencies.length > 0) definition.dependsOn = dependencies;
  if (rules.length > 0) definition.rules = rules;
  if (scenarios.length > 0) definition.scenarios = scenarios;
  if (checks.length > 0) definition.checks = checks;
  if (conventions.length > 0 || booleanOption(options.inferConventions)) {
    definition.governedBy = compactObject({
      inferFromScope: booleanOption(options.inferConventions) ? true : undefined,
      conventions: nonEmpty(conventions),
    });
  }
  definition.render = renderDefinition(renderKind, docs, style);

  const source = `import { defineSpec } from "@opencanon/core";

export default defineSpec(${JSON.stringify(definition, null, 2)});
`;
  const result: SpecDraftResult = {
    id,
    source,
    nextCommands: ["opencanon canon render specs", "opencanon doctor"],
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderSpecDraftMarkdown(result));
}

async function runSpecsHistoryCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon history spec");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSpecsHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon history spec");
  const target = await resolveSpecHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionHistoryGitArgs(target.files));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: SpecLogResult = {
    command: "history",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printSpecLogResult(result, formatOption(options.format));
}

async function runSpecsDiffCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon diff spec");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--from <ref>", "Start ref. Default: <to>^.");
  cli.option("--to <ref>", "End ref. Default: HEAD.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "from", "to"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSpecsHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon diff spec");
  const to = stringOptionOptional(options.to, "--to") ?? "HEAD";
  const from = stringOptionOptional(options.from, "--from") ?? `${to}^`;
  const target = await resolveSpecHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionDiffGitArgs({ from, to, files: target.files }));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: SpecDiffResult = {
    command: "diff",
    target,
    from,
    to,
    diff: git.stdout,
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderSpecDiffMarkdown(result));
}

async function runSpecsRelatedCommitsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon related-commits spec");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSpecsHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon related-commits spec");
  const target = await resolveSpecHistoryTarget(cwd, id);
  const argsBySource = buildRelatedDefinitionCommitsGitArgs({ id: target.id, files: target.files });
  const pathLog = runGit(cwd, argsBySource.path);
  if (pathLog.diagnostics.length > 0) fail(pathLog.diagnostics.join("\n"));
  const grepLog = runGit(cwd, argsBySource.grep);
  if (grepLog.diagnostics.length > 0) fail(grepLog.diagnostics.join("\n"));
  const result: SpecLogResult = {
    command: "related-commits",
    target,
    commits: dedupeCommits([...parseConventionGitLog(pathLog.stdout), ...parseConventionGitLog(grepLog.stdout)]),
  };
  printSpecLogResult(result, formatOption(options.format));
}

async function runSpecsVersionsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon versions spec");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printSpecsHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon versions spec");
  const target = await resolveSpecHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionVersionsGitArgs(target.definitionFiles));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: SpecLogResult = {
    command: "versions",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printSpecLogResult(result, formatOption(options.format));
}

async function renderGeneratedSpecs(cwd: string, options: { dryRun: boolean }): Promise<RenderSpecsResult> {
  const project = await loadProjectContext(cwd);
  const files: RenderedSpecFile[] = [];

  for (const spec of project.specs) {
    if (spec.render.kind !== SpecRenderKind.Generated) continue;
    const resolved = resolveSpecGeneratedDocsPath(project.paths, spec);
    if (!resolved.ok) fail(resolved.diagnostics.join("\n"));

    const expected = renderSpec(spec, spec.render.style);
    const current = existsSync(resolved.absolutePath) ? readFileSync(resolved.absolutePath, "utf8") : undefined;
    const changed = current !== expected;
    if (changed && !options.dryRun) writeAtomicTextFileSync(resolved.absolutePath, expected);

    files.push({
      id: spec.id,
      path: relative(project.rootDir, resolved.absolutePath),
      style: spec.render.style,
      action: changed ? (options.dryRun ? "would-write" : "written") : "unchanged",
    });
  }

  return {
    dryRun: options.dryRun,
    generated: files.length,
    changed: files.filter((file) => file.action !== "unchanged").length,
    files,
  };
}

function renderSpecsMarkdown(result: RenderSpecsResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Specs Render");
  lines.push("");
  lines.push(`Generated specs: ${result.generated}`);
  lines.push(`Changed files: ${result.changed}${result.dryRun ? " (dry-run)" : ""}`);
  for (const file of result.files) lines.push(`- [${file.action}] ${file.id} (${file.style}) -> ${file.path}`);
  return lines.join("\n");
}

async function resolveSpecHistoryTarget(cwd: string, id: string): Promise<SpecHistoryTarget> {
  const result = await loadSpecHistoryTarget(cwd, id);
  if (!result.ok) fail(result.diagnostics.join("\n"));
  return result.target;
}

function printSpecLogResult(result: SpecLogResult, format: Format): void {
  if (format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderSpecLogMarkdown(result));
}

function renderSpecLogMarkdown(result: SpecLogResult): string {
  const lines: string[] = [];
  lines.push(`# ${specLogTitle(result.command)}`);
  lines.push("");
  lines.push(`Spec: ${result.target.id}`);
  lines.push(`Title: ${result.target.title}`);
  lines.push("");
  lines.push("Files:");
  for (const file of result.target.files) lines.push(`- ${file}`);
  lines.push("");
  lines.push("Commits:");
  if (result.commits.length === 0) lines.push("- <none>");
  for (const commit of result.commits) lines.push(`- ${commit.hash} ${commit.date} ${commit.author} - ${commit.subject}`);
  return lines.join("\n");
}

function renderSpecDiffMarkdown(result: SpecDiffResult): string {
  return [
    "# Spec Diff",
    "",
    `Spec: ${result.target.id}`,
    `Title: ${result.target.title}`,
    `Refs: ${result.from}..${result.to}`,
    "",
    "Files:",
    ...result.target.files.map((file) => `- ${file}`),
    "",
    result.diff.trimEnd() || "No changes.",
  ].join("\n");
}

function specLogTitle(command: SpecLogResult["command"]): string {
  switch (command) {
    case "history":
      return "Spec History";
    case "related-commits":
      return "Spec Related Commits";
    case "versions":
      return "Spec Versions";
  }
}

function renderSpecsListMarkdown(result: SpecListResult): string {
  const lines = ["# OpenCanon Specs", ""];
  if (result.specs.length === 0) {
    lines.push("No specs are configured.");
    return lines.join("\n");
  }

  for (const spec of result.specs) {
    lines.push(`- ${spec.id}: ${spec.title}`);
    lines.push(`  - render: ${spec.render}`);
    lines.push(`  - checks: ${spec.checks}`);
    lines.push(`  - rules: ${spec.rules}`);
    lines.push(`  - scenarios: ${spec.scenarios}`);
    lines.push(`  - surfaces: ${spec.surfaces.length > 0 ? spec.surfaces.join(", ") : "<none>"}`);
    lines.push(`  - areas: ${spec.areas.length > 0 ? spec.areas.join(", ") : "<none>"}`);
    lines.push(`  - conventions: ${spec.conventions.length > 0 ? spec.conventions.join(", ") : "<none>"}`);
    if (spec.docs) lines.push(`  - docs: ${spec.docs}`);
  }
  return lines.join("\n");
}

function renderSpecDraftMarkdown(result: SpecDraftResult): string {
  return [
    "# OpenCanon Spec Draft",
    "",
    `Spec: ${result.id}`,
    "",
    "```ts",
    result.source.trimEnd(),
    "```",
    "",
    "Next:",
    ...result.nextCommands.map((command) => `- ${command}`),
  ].join("\n");
}

function requiredSingleArgument(args: readonly unknown[], command: string): string {
  const values = args.map(String);
  if (values.length === 0 || !values[0]) fail(`Missing ${command} id.`);
  if (values.length > 1) fail(`Unexpected ${command} arguments: ${values.slice(1).join(", ")}`);
  return values[0];
}

function stringOption(value: unknown, flag: string): string {
  if (typeof value !== "string" || value.trim() === "") fail(`${flag} requires a value.`);
  return value.trim();
}

function stringOptionOptional(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  return stringOption(value, flag);
}

function requiredStringOption(value: unknown, flag: string): string {
  const text = stringOptionOptional(value, flag);
  if (!text) fail(`${flag} is required.`);
  return text;
}

function renderKindOption(value: unknown, docs: string | undefined): SpecRenderKind {
  const kind = value === undefined ? (docs ? SpecRenderKind.Generated : SpecRenderKind.None) : stringOptionOptional(value, "--render");
  if (kind === SpecRenderKind.Generated || kind === SpecRenderKind.None) return kind;
  fail(`Unsupported --render: ${String(kind)}`);
}

function specRenderStyleOption(value: unknown): SpecRenderStyle {
  const style = stringOptionOptional(value, "--style") ?? SpecRenderStyle.Reference;
  if (Object.values(SpecRenderStyle).includes(style as SpecRenderStyle)) return style as SpecRenderStyle;
  fail(`Unsupported --style: ${style}`);
}

function renderDefinition(kind: SpecRenderKind, docs: string | undefined, style: SpecRenderStyle): Record<string, unknown> {
  if (kind === SpecRenderKind.None) return { kind };
  if (!docs) fail("--docs is required when --render is generated.");
  assertGeneratedDocsPath(docs, "--docs");
  return { kind, docs, style };
}

function assertGeneratedDocsPath(docs: string, flag: string): void {
  if (docs.includes("#")) fail(`${flag} must be a generated Markdown file path, not a heading reference.`);
  if (!/\.md$/iu.test(docs)) fail(`${flag} must point at a Markdown file.`);
}

function parseCommandCheck(value: string): Record<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) fail("--check-command must use id=command.");
  return { id: value.slice(0, separator), kind: SpecCheckKind.Command, command: value.slice(separator + 1) };
}

function parseDoctorCheck(value: string): Record<string, string> {
  const id = value.trim();
  if (!id) fail("--check-doctor requires a value.");
  return { id, kind: SpecCheckKind.Doctor };
}

function parseValidatorCheck(value: string): Record<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) fail("--check-validator must use id=validator-id.");
  return { id: value.slice(0, separator), kind: SpecCheckKind.Validator, validatorId: value.slice(separator + 1) };
}

function parseTestCheck(value: string): Record<string, string> {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) fail("--check-test must use id=target.");
  return { id: value.slice(0, separator), kind: SpecCheckKind.Test, target: value.slice(separator + 1) };
}

function parseRule(value: string): SpecRule {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) fail("--rule must use id=statement.");
  return { id: value.slice(0, separator), statement: value.slice(separator + 1) };
}

function attachAcceptanceItems(rules: SpecRule[], values: string[]): SpecRule[] {
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  for (const value of values) {
    const separator = value.indexOf("=");
    if (separator <= 0 || separator === value.length - 1) fail("--acceptance must use rule-id=text.");
    const ruleId = value.slice(0, separator);
    const rule = byId.get(ruleId);
    if (!rule) fail(`--acceptance references unknown rule: ${ruleId}`);
    rule.acceptance = [...(rule.acceptance ?? []), value.slice(separator + 1)];
  }
  return rules;
}

function parseScenario(value: string): SpecScenario {
  const separator = value.indexOf("=");
  if (separator <= 0 || separator === value.length - 1) fail("--scenario must use id=given;given|when|then;then.");
  const id = value.slice(0, separator);
  const parts = value.slice(separator + 1).split("|");
  if (parts.length !== 3) fail("--scenario must use id=given;given|when|then;then.");
  const [given = "", when = "", then = ""] = parts;
  return {
    id,
    given: splitScenarioList(given),
    when: when.trim(),
    then: splitScenarioList(then),
  };
}

function splitScenarioList(value: string): string[] {
  return value.split(";").map((item) => item.trim()).filter(Boolean);
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function printSpecsHelp(): void {
  console.log(`Usage:
  opencanon canon list specs
  opencanon canon draft spec <id> --title <title> --summary <summary>
  opencanon canon render specs
  opencanon canon history spec <id>
  opencanon canon diff spec <id> [--from <ref>] [--to <ref>]
  opencanon canon related-commits spec <id>
  opencanon canon versions spec <id>

Commands:
  list             List loaded spec definitions.
  draft            Print a TypeScript defineSpec snippet.
  render           Render every generated spec document.
  history          Show commits that touched a spec definition or doc.
  diff             Show spec definition/doc changes between refs.
  related-commits  Show path and commit-message references to a spec id.
  versions         List commits where the spec definition changed.

Options:
  --format markdown|json  Output format. Default: markdown.
  --dry-run               Show generated docs that would change without writing files.
`);
}
