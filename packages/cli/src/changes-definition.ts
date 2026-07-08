import { existsSync, readFileSync } from "node:fs";
import { cac } from "cac";
import {
  buildDefinitionDiffGitArgs,
  buildDefinitionHistoryGitArgs,
  buildDefinitionVersionsGitArgs,
  buildRelatedDefinitionCommitsGitArgs,
  ChangeCheckKind,
  ChangeKind,
  ChangeRenderKind,
  ChangeRenderStyle,
  createRenderLinkContext,
  dedupeCommits,
  DefinitionTargetKind,
  fail,
  Format,
  loadChangeHistoryTarget,
  parseConventionGitLog,
  relative,
  renderChange,
  resolveChangeGeneratedDocsPath,
  runGit,
  type ChangeHistoryTarget,
  type ConventionHistoryCommit,
  writeAtomicTextFileSync,
} from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";

const ChangeDefinitionCommand = {
  Render: "render",
  Draft: "draft",
  History: "history",
  Diff: "diff",
  RelatedCommits: "related-commits",
  Versions: "versions",
} as const;

export type ChangeDefinitionCommand = (typeof ChangeDefinitionCommand)[keyof typeof ChangeDefinitionCommand];

const changeDefinitionCommands = new Set<string>(Object.values(ChangeDefinitionCommand));

type RenderAction = "unchanged" | "written" | "would-write";

type RenderedChangeFile = {
  id: string;
  path: string;
  style: string;
  action: RenderAction;
};

type RenderChangesResult = {
  dryRun: boolean;
  generated: number;
  changed: number;
  files: RenderedChangeFile[];
};

type ChangeLogResult = {
  command: "history" | "related-commits" | "versions";
  target: ChangeHistoryTarget;
  commits: ConventionHistoryCommit[];
};

type ChangeDiffResult = {
  command: "diff";
  target: ChangeHistoryTarget;
  from: string;
  to: string;
  diff: string;
};

type ChangeDraftResult = {
  id: string;
  source: string;
  nextCommands: string[];
};

export function isChangeDefinitionCommand(command: string): command is ChangeDefinitionCommand {
  return changeDefinitionCommands.has(command);
}

export function changesDefinitionCommandSuggestion(command: string): string {
  if (command === ChangeDefinitionCommand.Render) return "opencanon canon render changes";
  if (command === ChangeDefinitionCommand.Draft) return "opencanon canon draft change <id>";
  return `opencanon canon ${command} change <id>`;
}

export async function runChangesDefinitionCommand(command: ChangeDefinitionCommand, args: string[], cwd: string): Promise<void> {
  switch (command) {
    case ChangeDefinitionCommand.Render:
      await runChangesRenderCommand(args, cwd);
      return;
    case ChangeDefinitionCommand.Draft:
      runChangesDraftCommand(args);
      return;
    case ChangeDefinitionCommand.History:
      await runChangesHistoryCommand(args, cwd);
      return;
    case ChangeDefinitionCommand.Diff:
      await runChangesDiffCommand(args, cwd);
      return;
    case ChangeDefinitionCommand.RelatedCommits:
      await runChangesRelatedCommitsCommand(args, cwd);
      return;
    case ChangeDefinitionCommand.Versions:
      await runChangesVersionsCommand(args, cwd);
      return;
  }
}

async function runChangesRenderCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon render changes");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--dry-run", "Show generated docs that would change without writing files.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "dryRun"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected canon render changes arguments: ${parsed.args.join(", ")}`);

  const result = await renderGeneratedChanges(cwd, { dryRun: booleanOption(options.dryRun) });
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangesMarkdown(result));
}

function runChangesDraftCommand(args: string[]): void {
  const cli = cac("opencanon canon draft change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--title <title>", "Change title.");
  cli.option("--kind <kind>", "Change kind: feature, fix, refactor, docs, chore, research. Default: feature.");
  cli.option("--summary <summary>", "Change summary.");
  cli.option("--problem <text>", "Problem statement.");
  cli.option("--outcome <text>", "Expected outcome.");
  cli.option("--why <text>", "Optional rationale.");
  cli.option("--file <glob>", "Scoped file or glob. Repeatable.");
  cli.option("--doc <path>", "Scoped doc path. Repeatable.");
  cli.option("--area <id>", "Area updated by this change. Repeatable.");
  cli.option("--spec <id>", "Spec updated by this change. Repeatable.");
  cli.option("--convention <id>", "Convention updated by this change. Repeatable.");
  cli.option("--surface <id>", "Impact surface updated by this change. Repeatable.");
  cli.option("--updates-doc <path>", "Documentation updated by this change. Repeatable.");
  cli.option("--check-command <id=command>", "Command check. Repeatable.");
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
    "kind",
    "summary",
    "problem",
    "outcome",
    "why",
    "file",
    "doc",
    "area",
    "spec",
    "convention",
    "surface",
    "updatesDoc",
    "checkCommand",
    "render",
    "docs",
    "style",
  ]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon draft change");
  const title = stringOption(options.title, "--title");
  const problem = stringOption(options.problem, "--problem");
  const outcome = stringOption(options.outcome, "--outcome");
  const docs = stringOptionOptional(options.docs, "--docs");
  const renderKind = renderKindOption(options.render, docs);
  const style = changeRenderStyleOption(options.style);
  const updates = compactObject({
    areas: nonEmpty(stringValues(options.area)),
    specs: nonEmpty(stringValues(options.spec)),
    conventions: nonEmpty(stringValues(options.convention)),
    surfaces: nonEmpty(stringValues(options.surface)),
    docs: nonEmpty(stringValues(options.updatesDoc)),
  });
  const scope = [
    ...stringValues(options.file).map((file) => ({ kind: DefinitionTargetKind.File, path: file })),
    ...stringValues(options.doc).map((doc) => ({ kind: DefinitionTargetKind.Doc, path: doc })),
  ];
  const checks = stringValues(options.checkCommand).map(parseCommandCheck);
  const intent = compactObject({
    problem,
    outcome,
    why: stringOptionOptional(options.why, "--why"),
  });
  const definition: Record<string, unknown> = {
    id,
    title,
    kind: changeKindOption(options.kind),
    intent,
  };
  const summary = stringOptionOptional(options.summary, "--summary");
  if (summary) definition.summary = summary;
  if (Object.keys(updates).length > 0) definition.updates = updates;
  if (scope.length > 0) definition.scope = scope;
  if (checks.length > 0) definition.checks = checks;
  definition.render = renderDefinition(renderKind, docs, style);

  const source = `import { defineChange } from "@opencanon/core";

export default defineChange(${JSON.stringify(definition, null, 2)});
`;
  const result: ChangeDraftResult = {
    id,
    source,
    nextCommands: ["opencanon canon render changes", "opencanon doctor"],
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangeDraftMarkdown(result));
}

async function runChangesHistoryCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon history change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon history change");
  const target = await resolveChangeHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionHistoryGitArgs(target.files));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ChangeLogResult = {
    command: "history",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printChangeLogResult(result, formatOption(options.format));
}

async function runChangesDiffCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon diff change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--from <ref>", "Start ref. Default: <to>^.");
  cli.option("--to <ref>", "End ref. Default: HEAD.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "from", "to"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon diff change");
  const to = stringOptionOptional(options.to, "--to") ?? "HEAD";
  const from = stringOptionOptional(options.from, "--from") ?? `${to}^`;
  const target = await resolveChangeHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionDiffGitArgs({ from, to, files: target.files }));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ChangeDiffResult = {
    command: "diff",
    target,
    from,
    to,
    diff: git.stdout,
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangeDiffMarkdown(result));
}

async function runChangesRelatedCommitsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon related-commits change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon related-commits change");
  const target = await resolveChangeHistoryTarget(cwd, id);
  const argsBySource = buildRelatedDefinitionCommitsGitArgs({ id: target.id, files: target.files });
  const pathLog = runGit(cwd, argsBySource.path);
  if (pathLog.diagnostics.length > 0) fail(pathLog.diagnostics.join("\n"));
  const grepLog = runGit(cwd, argsBySource.grep);
  if (grepLog.diagnostics.length > 0) fail(grepLog.diagnostics.join("\n"));
  const result: ChangeLogResult = {
    command: "related-commits",
    target,
    commits: dedupeCommits([...parseConventionGitLog(pathLog.stdout), ...parseConventionGitLog(grepLog.stdout)]),
  };
  printChangeLogResult(result, formatOption(options.format));
}

async function runChangesVersionsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon versions change");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printChangesDefinitionHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon versions change");
  const target = await resolveChangeHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionVersionsGitArgs(target.definitionFiles));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ChangeLogResult = {
    command: "versions",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printChangeLogResult(result, formatOption(options.format));
}

async function renderGeneratedChanges(cwd: string, options: { dryRun: boolean }): Promise<RenderChangesResult> {
  const project = await loadProjectContext(cwd);
  const linkContext = createRenderLinkContext(project);
  const files: RenderedChangeFile[] = [];

  for (const change of project.changes) {
    if (change.render.kind !== ChangeRenderKind.Generated) continue;
    const resolved = resolveChangeGeneratedDocsPath(project.paths, change);
    if (!resolved.ok) fail(resolved.diagnostics.join("\n"));

    const expected = renderChange(change, change.render.style, linkContext);
    const current = existsSync(resolved.absolutePath) ? readFileSync(resolved.absolutePath, "utf8") : undefined;
    const changed = current !== expected;
    if (changed && !options.dryRun) writeAtomicTextFileSync(resolved.absolutePath, expected);

    files.push({
      id: change.id,
      path: relative(project.rootDir, resolved.absolutePath),
      style: change.render.style,
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

function renderChangesMarkdown(result: RenderChangesResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Changes Render");
  lines.push("");
  lines.push(`Generated changes: ${result.generated}`);
  lines.push(`Changed files: ${result.changed}${result.dryRun ? " (dry-run)" : ""}`);
  for (const file of result.files) lines.push(`- [${file.action}] ${file.id} (${file.style}) -> ${file.path}`);
  return lines.join("\n");
}

async function resolveChangeHistoryTarget(cwd: string, id: string): Promise<ChangeHistoryTarget> {
  const result = await loadChangeHistoryTarget(cwd, id);
  if (!result.ok) fail(result.diagnostics.join("\n"));
  return result.target;
}

function printChangeLogResult(result: ChangeLogResult, format: Format): void {
  if (format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderChangeLogMarkdown(result));
}

function renderChangeLogMarkdown(result: ChangeLogResult): string {
  const lines: string[] = [];
  lines.push(`# ${changeLogTitle(result.command)}`);
  lines.push("");
  lines.push(`Change: ${result.target.id}`);
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

function renderChangeDiffMarkdown(result: ChangeDiffResult): string {
  return [
    "# Change Diff",
    "",
    `Change: ${result.target.id}`,
    `Title: ${result.target.title}`,
    `Refs: ${result.from}..${result.to}`,
    "",
    "Files:",
    ...result.target.files.map((file) => `- ${file}`),
    "",
    result.diff.trimEnd() || "No changes.",
  ].join("\n");
}

function renderChangeDraftMarkdown(result: ChangeDraftResult): string {
  return [
    "# OpenCanon Change Draft",
    "",
    `Change: ${result.id}`,
    "",
    "```ts",
    result.source.trimEnd(),
    "```",
    "",
    "Next:",
    ...result.nextCommands.map((command) => `- ${command}`),
  ].join("\n");
}

function changeLogTitle(command: ChangeLogResult["command"]): string {
  switch (command) {
    case "history":
      return "Change History";
    case "related-commits":
      return "Change Related Commits";
    case "versions":
      return "Change Versions";
  }
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

function renderKindOption(value: unknown, docs: string | undefined): ChangeRenderKind {
  const kind = value === undefined ? (docs ? ChangeRenderKind.Generated : ChangeRenderKind.None) : stringOptionOptional(value, "--render");
  if (kind === ChangeRenderKind.Generated || kind === ChangeRenderKind.None) return kind;
  fail(`Unsupported --render: ${String(kind)}`);
}

function changeRenderStyleOption(value: unknown): ChangeRenderStyle {
  const style = stringOptionOptional(value, "--style") ?? ChangeRenderStyle.Reference;
  if (Object.values(ChangeRenderStyle).includes(style as ChangeRenderStyle)) return style as ChangeRenderStyle;
  fail(`Unsupported --style: ${style}`);
}

function changeKindOption(value: unknown): ChangeKind {
  const kind = stringOptionOptional(value, "--kind") ?? ChangeKind.Feature;
  if (Object.values(ChangeKind).includes(kind as ChangeKind)) return kind as ChangeKind;
  fail(`Unsupported --kind: ${kind}`);
}

function renderDefinition(kind: ChangeRenderKind, docs: string | undefined, style: ChangeRenderStyle): Record<string, unknown> {
  if (kind === ChangeRenderKind.None) return { kind };
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
  return { id: value.slice(0, separator), kind: ChangeCheckKind.Command, command: value.slice(separator + 1) };
}

function compactObject(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

function nonEmpty<T>(values: T[]): T[] | undefined {
  return values.length > 0 ? values : undefined;
}

function printChangesDefinitionHelp(): void {
  console.log(`Usage:
  opencanon canon render changes
  opencanon canon draft change <id> --title <title> --problem <problem> --outcome <outcome>
  opencanon canon history change <id>
  opencanon canon diff change <id>
  opencanon canon related-commits change <id>
  opencanon canon versions change <id>

Options:
  --format markdown|json     Output format. Default: markdown.
  --dry-run                  For render: show generated docs that would change.
  --title <title>            For draft: change title.
  --kind <kind>              For draft: feature, fix, refactor, docs, chore, research.
  --summary <summary>        For draft: short summary.
  --problem <text>           For draft: problem statement.
  --outcome <text>           For draft: expected outcome.
  --why <text>               For draft: optional rationale.
  --file <glob>              For draft: scoped file or glob. Repeatable.
  --doc <path>               For draft: scoped doc path. Repeatable.
  --area <id>                For draft: updated area. Repeatable.
  --spec <id>                For draft: updated spec. Repeatable.
  --convention <id>          For draft: updated convention. Repeatable.
  --surface <id>             For draft: updated impact surface. Repeatable.
  --updates-doc <path>       For draft: updated docs path. Repeatable.
  --check-command <id=cmd>   For draft: command check. Repeatable.
  --render generated|none    For draft: docs render mode.
  --docs <path>              For draft: generated docs path.
  --style <style>            For draft: generated docs style.
  --from <ref>               For diff: start ref. Default: <to>^.
  --to <ref>                 For diff: end ref. Default: HEAD.
`);
}
