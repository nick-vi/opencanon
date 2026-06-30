import { existsSync, readFileSync } from "node:fs";
import { cac } from "cac";
import {
  AreaCheckKind,
  AreaRenderKind,
  AreaRenderStyle,
  buildDefinitionDiffGitArgs,
  buildDefinitionHistoryGitArgs,
  buildDefinitionVersionsGitArgs,
  buildRelatedDefinitionCommitsGitArgs,
  dedupeCommits,
  DefinitionTargetKind,
  fail,
  Format,
  loadAreaHistoryTarget,
  parseConventionGitLog,
  relative,
  renderArea,
  resolveAreaGeneratedDocsPath,
  runGit,
  type AreaHistoryTarget,
  type ConventionHistoryCommit,
  writeAtomicTextFileSync,
} from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";

type RenderAction = "unchanged" | "written" | "would-write";

type RenderedAreaFile = {
  id: string;
  path: string;
  style: string;
  action: RenderAction;
};

type RenderAreasResult = {
  dryRun: boolean;
  generated: number;
  changed: number;
  files: RenderedAreaFile[];
};

type AreaListResult = {
  areas: Array<{
    id: string;
    title: string;
    render: string;
    docs?: string;
    checks: number;
    surfaces: string[];
  }>;
};

type AreaLogResult = {
  command: "history" | "related-commits" | "versions";
  target: AreaHistoryTarget;
  commits: ConventionHistoryCommit[];
};

type AreaDiffResult = {
  command: "diff";
  target: AreaHistoryTarget;
  from: string;
  to: string;
  diff: string;
};

type AreaDraftResult = {
  id: string;
  source: string;
  nextCommands: string[];
};

export async function runAreasCommand(args: string[], cwd: string): Promise<void> {
  const [command = "list", ...rest] = args;
  if (command === "-h" || command === "--help" || command === "help") {
    printAreasHelp();
    return;
  }
  if (command === "list") {
    await runAreasListCommand(rest, cwd);
    return;
  }
  if (command === "render") {
    await runAreasRenderCommand(rest, cwd);
    return;
  }
  if (command === "draft") {
    runAreasDraftCommand(rest);
    return;
  }
  if (command === "history") {
    await runAreasHistoryCommand(rest, cwd);
    return;
  }
  if (command === "diff") {
    await runAreasDiffCommand(rest, cwd);
    return;
  }
  if (command === "related-commits") {
    await runAreasRelatedCommitsCommand(rest, cwd);
    return;
  }
  if (command === "versions") {
    await runAreasVersionsCommand(rest, cwd);
    return;
  }
  fail(`Unknown areas command: ${command}`);
}

async function runAreasListCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon list areas");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printAreasHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected canon list areas arguments: ${parsed.args.join(", ")}`);

  const project = await loadProjectContext(cwd);
  const result: AreaListResult = {
    areas: project.areas
      .map((area) => ({
        id: area.id,
        title: area.title,
        render: area.render.kind,
        docs: area.render.kind === AreaRenderKind.None ? undefined : area.render.docs,
        checks: area.checks?.length ?? 0,
        surfaces: area.surfaces ?? [],
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };

  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderAreasListMarkdown(result));
}

async function runAreasRenderCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon render areas");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--dry-run", "Show generated docs that would change without writing files.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "dryRun"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printAreasHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected canon render areas arguments: ${parsed.args.join(", ")}`);

  const result = await renderGeneratedAreas(cwd, { dryRun: booleanOption(options.dryRun) });
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderAreasMarkdown(result));
}

function runAreasDraftCommand(args: string[]): void {
  const cli = cac("opencanon canon draft area");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--title <title>", "Area title.");
  cli.option("--summary <summary>", "Area summary.");
  cli.option("--file <glob>", "Owned file or glob. Repeatable.");
  cli.option("--doc <path>", "Owned doc path. Repeatable.");
  cli.option("--surface <id>", "Impact surface id. Repeatable.");
  cli.option("--check-command <id=command>", "Command check. Repeatable.");
  cli.option("--render <kind>", "Render kind: generated or none. Default: generated when --docs is set, otherwise none.");
  cli.option("--docs <path>", "Generated docs path.");
  cli.option("--style <style>", "Generated docs render style. Default: reference.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "title", "summary", "file", "doc", "surface", "checkCommand", "render", "docs", "style"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printAreasHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon draft area");
  const title = requiredStringOption(options.title, "--title");
  const summary = requiredStringOption(options.summary, "--summary");
  const docs = stringOption(options.docs, "--docs");
  const renderKind = renderKindOption(options.render, docs);
  const style = areaRenderStyleOption(options.style);
  const definition: Record<string, unknown> = {
    id,
    title,
    summary,
  };
  const surfaces = stringValues(options.surface);
  const owns = [
    ...stringValues(options.file).map((file) => ({ kind: DefinitionTargetKind.File, path: file })),
    ...stringValues(options.doc).map((doc) => ({ kind: DefinitionTargetKind.Doc, path: doc })),
  ];
  const checks = stringValues(options.checkCommand).map(parseCommandCheck);
  if (surfaces.length > 0) definition.surfaces = surfaces;
  if (owns.length > 0) definition.owns = owns;
  if (checks.length > 0) definition.checks = checks;
  definition.render = renderDefinition(renderKind, docs, style);

  const source = `import { defineArea } from "@opencanon/core";

export default defineArea(${JSON.stringify(definition, null, 2)});
`;
  const result: AreaDraftResult = {
    id,
    source,
    nextCommands: ["opencanon canon render areas", "opencanon doctor"],
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderAreaDraftMarkdown(result));
}

async function runAreasHistoryCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon history area");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printAreasHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon history area");
  const target = await resolveAreaHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionHistoryGitArgs(target.files));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: AreaLogResult = {
    command: "history",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printAreaLogResult(result, formatOption(options.format));
}

async function runAreasDiffCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon diff area");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--from <ref>", "Start ref. Default: <to>^.");
  cli.option("--to <ref>", "End ref. Default: HEAD.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "from", "to"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printAreasHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon diff area");
  const to = stringOption(options.to, "--to") ?? "HEAD";
  const from = stringOption(options.from, "--from") ?? `${to}^`;
  const target = await resolveAreaHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionDiffGitArgs({ from, to, files: target.files }));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: AreaDiffResult = {
    command: "diff",
    target,
    from,
    to,
    diff: git.stdout,
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderAreaDiffMarkdown(result));
}

async function runAreasRelatedCommitsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon related-commits area");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printAreasHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon related-commits area");
  const target = await resolveAreaHistoryTarget(cwd, id);
  const argsBySource = buildRelatedDefinitionCommitsGitArgs({ id: target.id, files: target.files });
  const pathLog = runGit(cwd, argsBySource.path);
  if (pathLog.diagnostics.length > 0) fail(pathLog.diagnostics.join("\n"));
  const grepLog = runGit(cwd, argsBySource.grep);
  if (grepLog.diagnostics.length > 0) fail(grepLog.diagnostics.join("\n"));
  const result: AreaLogResult = {
    command: "related-commits",
    target,
    commits: dedupeCommits([...parseConventionGitLog(pathLog.stdout), ...parseConventionGitLog(grepLog.stdout)]),
  };
  printAreaLogResult(result, formatOption(options.format));
}

async function runAreasVersionsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon versions area");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printAreasHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon versions area");
  const target = await resolveAreaHistoryTarget(cwd, id);
  const git = runGit(cwd, buildDefinitionVersionsGitArgs(target.definitionFiles));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: AreaLogResult = {
    command: "versions",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printAreaLogResult(result, formatOption(options.format));
}

async function renderGeneratedAreas(cwd: string, options: { dryRun: boolean }): Promise<RenderAreasResult> {
  const project = await loadProjectContext(cwd);
  const files: RenderedAreaFile[] = [];

  for (const area of project.areas) {
    if (area.render.kind !== AreaRenderKind.Generated) continue;
    const resolved = resolveAreaGeneratedDocsPath(project.paths, area);
    if (!resolved.ok) fail(resolved.diagnostics.join("\n"));

    const expected = renderArea(area, area.render.style);
    const current = existsSync(resolved.absolutePath) ? readFileSync(resolved.absolutePath, "utf8") : undefined;
    const changed = current !== expected;
    if (changed && !options.dryRun) writeAtomicTextFileSync(resolved.absolutePath, expected);

    files.push({
      id: area.id,
      path: relative(project.rootDir, resolved.absolutePath),
      style: area.render.style,
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

function renderAreasMarkdown(result: RenderAreasResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Areas Render");
  lines.push("");
  lines.push(`Generated areas: ${result.generated}`);
  lines.push(`Changed files: ${result.changed}${result.dryRun ? " (dry-run)" : ""}`);
  for (const file of result.files) lines.push(`- [${file.action}] ${file.id} (${file.style}) -> ${file.path}`);
  return lines.join("\n");
}

async function resolveAreaHistoryTarget(cwd: string, id: string): Promise<AreaHistoryTarget> {
  const result = await loadAreaHistoryTarget(cwd, id);
  if (!result.ok) fail(result.diagnostics.join("\n"));
  return result.target;
}

function printAreaLogResult(result: AreaLogResult, format: Format): void {
  if (format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderAreaLogMarkdown(result));
}

function renderAreaLogMarkdown(result: AreaLogResult): string {
  const lines: string[] = [];
  lines.push(`# ${areaLogTitle(result.command)}`);
  lines.push("");
  lines.push(`Area: ${result.target.id}`);
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

function renderAreaDiffMarkdown(result: AreaDiffResult): string {
  return [
    "# Area Diff",
    "",
    `Area: ${result.target.id}`,
    `Title: ${result.target.title}`,
    `Refs: ${result.from}..${result.to}`,
    "",
    "Files:",
    ...result.target.files.map((file) => `- ${file}`),
    "",
    result.diff.trimEnd() || "No changes.",
  ].join("\n");
}

function areaLogTitle(command: AreaLogResult["command"]): string {
  switch (command) {
    case "history":
      return "Area History";
    case "related-commits":
      return "Area Related Commits";
    case "versions":
      return "Area Versions";
  }
}

function renderAreasListMarkdown(result: AreaListResult): string {
  const lines = ["# OpenCanon Areas", ""];
  if (result.areas.length === 0) {
    lines.push("No areas are configured.");
    return lines.join("\n");
  }

  for (const area of result.areas) {
    lines.push(`- ${area.id}: ${area.title}`);
    lines.push(`  - render: ${area.render}`);
    lines.push(`  - checks: ${area.checks}`);
    lines.push(`  - surfaces: ${area.surfaces.length > 0 ? area.surfaces.join(", ") : "<none>"}`);
    if (area.docs) lines.push(`  - docs: ${area.docs}`);
  }
  return lines.join("\n");
}

function renderAreaDraftMarkdown(result: AreaDraftResult): string {
  return [
    "# OpenCanon Area Draft",
    "",
    `Area: ${result.id}`,
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

function stringOption(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) fail(`${flag} requires a value.`);
  return value;
}

function requiredStringOption(value: unknown, flag: string): string {
  const text = stringOption(value, flag);
  if (!text) fail(`${flag} is required.`);
  return text;
}

function renderKindOption(value: unknown, docs: string | undefined): AreaRenderKind {
  const kind = value === undefined ? (docs ? AreaRenderKind.Generated : AreaRenderKind.None) : stringOption(value, "--render");
  if (kind === AreaRenderKind.Generated || kind === AreaRenderKind.None) return kind;
  fail(`Unsupported --render: ${String(kind)}`);
}

function areaRenderStyleOption(value: unknown): AreaRenderStyle {
  const style = stringOption(value, "--style") ?? AreaRenderStyle.Reference;
  if (Object.values(AreaRenderStyle).includes(style as AreaRenderStyle)) return style as AreaRenderStyle;
  fail(`Unsupported --style: ${style}`);
}

function renderDefinition(kind: AreaRenderKind, docs: string | undefined, style: AreaRenderStyle): Record<string, unknown> {
  if (kind === AreaRenderKind.None) return { kind };
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
  return { id: value.slice(0, separator), kind: AreaCheckKind.Command, command: value.slice(separator + 1) };
}

function printAreasHelp(): void {
  console.log(`Usage:
  opencanon canon list areas
  opencanon canon draft area <id> --title <title> --summary <summary>
  opencanon canon render areas
  opencanon canon history area <id>
  opencanon canon diff area <id> [--from <ref>] [--to <ref>]
  opencanon canon related-commits area <id>
  opencanon canon versions area <id>

Commands:
  list             List loaded area definitions.
  draft            Print a TypeScript defineArea snippet.
  render           Render every generated area document.
  history          Show commits that touched an area definition or doc.
  diff             Show area definition/doc changes between refs.
  related-commits  Show path and commit-message references to an area id.
  versions         List commits where the area definition changed.

Options:
  --format markdown|json  Output format. Default: markdown.
  --dry-run               Show generated docs that would change without writing files.
`);
}
