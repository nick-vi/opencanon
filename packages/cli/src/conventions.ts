import { existsSync, readFileSync } from "node:fs";
import { cac } from "cac";
import {
  ConventionRenderKind,
  createRenderLinkContext,
  fail,
  Format,
  renderConvention,
  resolveConventionGeneratedDocsPath,
  relative,
  writeAtomicTextFileSync,
  buildConventionDiffGitArgs,
  buildConventionHistoryGitArgs,
  buildConventionVersionsGitArgs,
  buildImpactEvolutionGitArgs,
  buildRelatedCommitsGitArgs,
  dedupeCommits,
  loadConventionHistoryTarget,
  loadImpactEvolutionTarget,
  parseConventionGitLog,
  runGit,
  type ConventionHistoryCommit,
  type ConventionHistoryTarget,
  type ImpactEvolutionTarget,
} from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";

type RenderAction = "unchanged" | "written" | "would-write";

type RenderedConventionFile = {
  id: string;
  path: string;
  style: string;
  action: RenderAction;
};

type RenderConventionsResult = {
  dryRun: boolean;
  generated: number;
  changed: number;
  files: RenderedConventionFile[];
};

type ConventionListResult = {
  conventions: Array<{
    id: string;
    title: string;
    topics: string[];
    render: string;
    runtime: string;
    docs?: string;
  }>;
};

type ConventionLogResult = {
  command: "history" | "related-commits" | "versions" | "impact-evolution";
  target: ConventionHistoryTarget | ImpactEvolutionTarget;
  commits: ConventionHistoryCommit[];
};

type ConventionDiffResult = {
  command: "diff";
  target: ConventionHistoryTarget;
  from: string;
  to: string;
  diff: string;
};

type ConventionDraftResult = {
  id: string;
  source: string;
  nextCommands: string[];
};

const ConventionDraftRenderKind = {
  Generated: "generated",
  None: "none",
} as const;
type ConventionDraftRenderKind = (typeof ConventionDraftRenderKind)[keyof typeof ConventionDraftRenderKind];

const ConventionDraftRuntimeKind = {
  None: "none",
  Validator: "validator",
} as const;
type ConventionDraftRuntimeKind = (typeof ConventionDraftRuntimeKind)[keyof typeof ConventionDraftRuntimeKind];

export async function runConventionsCommand(args: string[], cwd: string): Promise<void> {
  const [command, ...rest] = args;
  if (!command || command === "-h" || command === "--help" || command === "help") {
    printConventionsHelp();
    return;
  }
  if (command === "render") {
    await runConventionsRenderCommand(rest, cwd);
    return;
  }
  if (command === "list") {
    await runConventionsListCommand(rest, cwd);
    return;
  }
  if (command === "draft") {
    runConventionsDraftCommand(rest);
    return;
  }
  if (command === "history") {
    await runConventionsHistoryCommand(rest, cwd);
    return;
  }
  if (command === "diff") {
    await runConventionsDiffCommand(rest, cwd);
    return;
  }
  if (command === "related-commits") {
    await runConventionsRelatedCommitsCommand(rest, cwd);
    return;
  }
  if (command === "versions") {
    await runConventionsVersionsCommand(rest, cwd);
    return;
  }
  if (command === "impact-evolution") {
    await runConventionsImpactEvolutionCommand(rest, cwd);
    return;
  }
  fail(`Unknown conventions command: ${command}`);
}

function runConventionsDraftCommand(args: string[]): void {
  const cli = cac("opencanon canon draft convention");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--title <title>", "Convention title.");
  cli.option("--rule <rule>", "Convention rule.");
  cli.option("--topic <topic>", "Topic. Repeatable.");
  cli.option("--file <glob>", "File glob the convention applies to. Repeatable.");
  cli.option("--docs <path>", "Generated docs path.");
  cli.option("--render <kind>", "Render kind: generated or none. Default: generated when --docs is set, otherwise none.");
  cli.option("--runtime <kind>", "Runtime kind: none, validator. Default: none.");
  cli.option("--severity <severity>", "Validator severity. Default: warning.");
  cli.option("--facts <facts>", "Comma-separated fact kinds for a validator runtime.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "title", "rule", "topic", "file", "docs", "render", "runtime", "severity", "facts"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printConventionsHelp();
    return;
  }

  const id = requiredSingleArgument(parsed.args, "canon draft convention");
  const title = requiredStringOption(options.title, "--title");
  const rule = requiredStringOption(options.rule, "--rule");
  const topics = stringValues(options.topic);
  const files = stringValues(options.file);
  const docs = stringOption(options.docs, "--docs");
  const renderKind = conventionDraftRenderKind(options.render, docs);
  const runtimeKind = conventionDraftRuntimeKind(options.runtime);
  const source = renderConventionDraftSource({
    id,
    title,
    rule,
    topics,
    files,
    docs,
    renderKind,
    runtimeKind,
    severity: stringOption(options.severity, "--severity") ?? "warning",
    facts: stringOption(options.facts, "--facts")?.split(",").map((fact) => fact.trim()).filter(Boolean) ?? [],
  });
  const result: ConventionDraftResult = {
    id,
    source,
    nextCommands: ["opencanon canon render conventions", "opencanon validate --check-fixtures", "opencanon doctor"],
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderConventionDraftMarkdown(result));
}

async function runConventionsListCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon list conventions");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printConventionsHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected canon list conventions arguments: ${parsed.args.join(", ")}`);

  const project = await loadProjectContext(cwd);
  const result: ConventionListResult = {
    conventions: project.conventions
      .map((convention) => ({
        id: convention.id,
        title: convention.title,
        topics: convention.topics ?? [],
        render: convention.render.kind,
        runtime: convention.runtime.kind,
        docs: convention.render.kind === ConventionRenderKind.None ? undefined : convention.render.docs,
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };

  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderConventionsListMarkdown(result));
}

async function runConventionsRenderCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon render conventions");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--dry-run", "Show generated docs that would change without writing files.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "dryRun"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printConventionsHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unexpected canon render conventions arguments: ${parsed.args.join(", ")}`);

  const format = formatOption(options.format);
  const result = await renderGeneratedConventions(cwd, { dryRun: booleanOption(options.dryRun) });
  if (format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderConventionsMarkdown(result));
}

async function runConventionsHistoryCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon history convention");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printConventionsHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon history convention");
  const target = await resolveConventionHistoryTarget(cwd, id);
  const git = runGit(cwd, buildConventionHistoryGitArgs(target.files));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ConventionLogResult = {
    command: "history",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printConventionLogResult(result, formatOption(options.format));
}

async function runConventionsDiffCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon diff convention");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--from <ref>", "Start ref. Default: <to>^.");
  cli.option("--to <ref>", "End ref. Default: HEAD.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "from", "to"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printConventionsHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon diff convention");
  const to = stringOption(options.to, "--to") ?? "HEAD";
  const from = stringOption(options.from, "--from") ?? `${to}^`;
  const target = await resolveConventionHistoryTarget(cwd, id);
  const git = runGit(cwd, buildConventionDiffGitArgs({ from, to, files: target.files }));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ConventionDiffResult = {
    command: "diff",
    target,
    from,
    to,
    diff: git.stdout,
  };
  if (formatOption(options.format) === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderConventionDiffMarkdown(result));
}

async function runConventionsRelatedCommitsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon related-commits convention");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printConventionsHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon related-commits convention");
  const target = await resolveConventionHistoryTarget(cwd, id);
  const argsBySource = buildRelatedCommitsGitArgs({ id: target.id, files: target.files });
  const pathLog = runGit(cwd, argsBySource.path);
  if (pathLog.diagnostics.length > 0) fail(pathLog.diagnostics.join("\n"));
  const grepLog = runGit(cwd, argsBySource.grep);
  if (grepLog.diagnostics.length > 0) fail(grepLog.diagnostics.join("\n"));
  const result: ConventionLogResult = {
    command: "related-commits",
    target,
    commits: dedupeCommits([...parseConventionGitLog(pathLog.stdout), ...parseConventionGitLog(grepLog.stdout)]),
  };
  printConventionLogResult(result, formatOption(options.format));
}

async function runConventionsVersionsCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon versions convention");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printConventionsHelp();
    return;
  }
  const id = requiredSingleArgument(parsed.args, "canon versions convention");
  const target = await resolveConventionHistoryTarget(cwd, id);
  const git = runGit(cwd, buildConventionVersionsGitArgs(target.definitionFiles));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ConventionLogResult = {
    command: "versions",
    target,
    commits: parseConventionGitLog(git.stdout),
  };
  printConventionLogResult(result, formatOption(options.format));
}

async function runConventionsImpactEvolutionCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon canon impact-evolution convention");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printConventionsHelp();
    return;
  }
  const surfaceId = requiredSingleArgument(parsed.args, "canon impact-evolution convention");
  const targetResult = await loadImpactEvolutionTarget(cwd, surfaceId);
  if (!targetResult.ok) fail(targetResult.diagnostics.join("\n"));
  const git = runGit(cwd, buildImpactEvolutionGitArgs(targetResult.target.files));
  if (git.diagnostics.length > 0) fail(git.diagnostics.join("\n"));
  const result: ConventionLogResult = {
    command: "impact-evolution",
    target: targetResult.target,
    commits: parseConventionGitLog(git.stdout),
  };
  printConventionLogResult(result, formatOption(options.format));
}

async function renderGeneratedConventions(cwd: string, options: { dryRun: boolean }): Promise<RenderConventionsResult> {
  const project = await loadProjectContext(cwd);
  const linkContext = createRenderLinkContext(project);
  const files: RenderedConventionFile[] = [];

  for (const convention of project.conventions) {
    if (convention.render.kind !== ConventionRenderKind.Generated) continue;
    const resolved = resolveConventionGeneratedDocsPath(project.paths, convention);
    if (!resolved.ok) fail(resolved.diagnostics.join("\n"));

    const expected = renderConvention(convention, convention.render.style, linkContext);
    const current = existsSync(resolved.absolutePath) ? readFileSync(resolved.absolutePath, "utf8") : undefined;
    const changed = current !== expected;
    if (changed && !options.dryRun) writeAtomicTextFileSync(resolved.absolutePath, expected);

    files.push({
      id: convention.id,
      path: relative(project.rootDir, resolved.absolutePath),
      style: convention.render.style,
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

function renderConventionsMarkdown(result: RenderConventionsResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Conventions Render");
  lines.push("");
  lines.push(`Generated conventions: ${result.generated}`);
  lines.push(`Changed files: ${result.changed}${result.dryRun ? " (dry-run)" : ""}`);
  for (const file of result.files) lines.push(`- [${file.action}] ${file.id} (${file.style}) -> ${file.path}`);
  return lines.join("\n");
}

async function resolveConventionHistoryTarget(cwd: string, id: string): Promise<ConventionHistoryTarget> {
  const result = await loadConventionHistoryTarget(cwd, id);
  if (!result.ok) fail(result.diagnostics.join("\n"));
  return result.target;
}

function renderConventionsListMarkdown(result: ConventionListResult): string {
  const lines = ["# OpenCanon Conventions", ""];
  if (result.conventions.length === 0) {
    lines.push("No conventions are configured.");
    return lines.join("\n");
  }

  for (const convention of result.conventions) {
    lines.push(`- ${convention.id}: ${convention.title}`);
    lines.push(`  - topics: ${convention.topics.length > 0 ? convention.topics.join(", ") : "<none>"}`);
    lines.push(`  - render: ${convention.render}`);
    lines.push(`  - runtime: ${convention.runtime}`);
    if (convention.docs) lines.push(`  - docs: ${convention.docs}`);
  }
  return lines.join("\n");
}

function printConventionLogResult(result: ConventionLogResult, format: Format): void {
  if (format === Format.Json) console.log(JSON.stringify(result, null, 2));
  else console.log(renderConventionLogMarkdown(result));
}

function renderConventionLogMarkdown(result: ConventionLogResult): string {
  const lines: string[] = [];
  lines.push(`# ${conventionLogTitle(result.command)}`);
  lines.push("");
  if ("id" in result.target) {
    lines.push(`Convention: ${result.target.id}`);
    lines.push(`Title: ${result.target.title}`);
    lines.push("");
    lines.push("Files:");
    for (const file of result.target.files) lines.push(`- ${file}`);
  } else {
    lines.push(`Impact surface: ${result.target.surfaceId}`);
    if (result.target.title) lines.push(`Title: ${result.target.title}`);
    lines.push(`Conventions: ${result.target.conventionIds.length > 0 ? result.target.conventionIds.join(", ") : "<none>"}`);
    lines.push("");
    lines.push("Files:");
    for (const file of result.target.files) lines.push(`- ${file}`);
  }

  lines.push("");
  lines.push("Commits:");
  if (result.commits.length === 0) lines.push("- <none>");
  for (const commit of result.commits) lines.push(`- ${commit.hash} ${commit.date} ${commit.author} - ${commit.subject}`);
  return lines.join("\n");
}

function renderConventionDiffMarkdown(result: ConventionDiffResult): string {
  return [
    "# Convention Diff",
    "",
    `Convention: ${result.target.id}`,
    `Title: ${result.target.title}`,
    `Refs: ${result.from}..${result.to}`,
    "",
    "Files:",
    ...result.target.files.map((file) => `- ${file}`),
    "",
    result.diff.trimEnd() || "No changes.",
  ].join("\n");
}

function conventionLogTitle(command: ConventionLogResult["command"]): string {
  switch (command) {
    case "history":
      return "Convention History";
    case "related-commits":
      return "Convention Related Commits";
    case "versions":
      return "Convention Versions";
    case "impact-evolution":
      return "Impact Surface Evolution";
  }
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
  const result = stringOption(value, flag);
  if (!result) fail(`${flag} is required.`);
  return result;
}

function conventionDraftRenderKind(value: unknown, docs?: string): ConventionDraftRenderKind {
  const raw = stringOption(value, "--render") ?? (docs ? ConventionDraftRenderKind.Generated : ConventionDraftRenderKind.None);
  if (raw === ConventionDraftRenderKind.Generated || raw === ConventionDraftRenderKind.None) return raw;
  fail("--render must be generated or none.");
}

function conventionDraftRuntimeKind(value: unknown): ConventionDraftRuntimeKind {
  const raw = stringOption(value, "--runtime") ?? ConventionDraftRuntimeKind.None;
  if (raw === ConventionDraftRuntimeKind.None || raw === ConventionDraftRuntimeKind.Validator) return raw;
  fail("--runtime must be none or validator.");
}

function assertGeneratedDocsPath(docs: string, flag: string): void {
  if (docs.includes("#")) fail(`${flag} must be a generated Markdown file path, not a heading reference.`);
  if (!/\.md$/iu.test(docs)) fail(`${flag} must point at a Markdown file.`);
}

function renderConventionDraftSource(input: {
  id: string;
  title: string;
  rule: string;
  topics: string[];
  files: string[];
  docs?: string;
  renderKind: ConventionDraftRenderKind;
  runtimeKind: ConventionDraftRuntimeKind;
  severity: string;
  facts: string[];
}): string {
  const generatedDocs = input.docs ?? `docs/opencanon/canon/${input.id}.md`;
  if (input.renderKind === ConventionDraftRenderKind.Generated) assertGeneratedDocsPath(generatedDocs, "--docs");
  const render =
    input.renderKind === ConventionDraftRenderKind.None
      ? "{ kind: \"none\" }"
      : `{ kind: "generated", docs: ${JSON.stringify(generatedDocs)}, style: "reference" }`;
  const runtime =
    input.runtimeKind === ConventionDraftRuntimeKind.None
      ? "{ kind: \"none\" }"
      : [
          "{",
          "    kind: \"validator\",",
          `    severity: ${JSON.stringify(input.severity)},`,
          "    scope: \"file\",",
          `    facts: ${JSON.stringify(input.facts)},`,
          "    validate({ ctx }) {",
          "      void ctx;",
          "      return [];",
          "    },",
          "  }",
        ].join("\n");
  return `import { defineConvention } from "@opencanon/core";

export default defineConvention({
  id: ${JSON.stringify(input.id)},
  title: ${JSON.stringify(input.title)},
  topics: ${JSON.stringify(input.topics)},
  rule: ${JSON.stringify(input.rule)},
  applies: { kind: "files", globs: ${JSON.stringify(input.files.length > 0 ? input.files : ["src/**/*.{ts,tsx}"])} },
  render: ${render},
  runtime: ${runtime},
});
`;
}

function renderConventionDraftMarkdown(result: ConventionDraftResult): string {
  return [
    "# Convention Draft",
    "",
    `Convention: ${result.id}`,
    "",
    "```ts",
    result.source.trimEnd(),
    "```",
    "",
    "Next commands:",
    ...result.nextCommands.map((command) => `- ${command}`),
  ].join("\n");
}

function printConventionsHelp(): void {
  console.log(`Usage:
  opencanon canon list conventions
  opencanon canon draft convention <id> --title <title> --rule <rule>
  opencanon canon render conventions
  opencanon canon history convention <id>
  opencanon canon diff convention <id> [--from <ref>] [--to <ref>]
  opencanon canon related-commits convention <id>
  opencanon canon versions convention <id>
  opencanon canon impact-evolution convention <surfaceId>

Commands:
  list              List loaded conventions.
  draft             Print a TypeScript defineConvention snippet.
  render            Render every generated convention document.
  history           Show commits that touched a convention definition or doc.
  diff              Show convention definition/doc changes between refs.
  related-commits   Show path and commit-message references to a convention id.
  versions          List commits where the convention definition changed.
  impact-evolution  Show commits affecting an impact surface's convention links.

Options:
  --format markdown|json  Output format. Default: markdown.
  --dry-run               Show generated docs that would change without writing files.
`);
}
