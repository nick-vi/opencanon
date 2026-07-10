import { cac } from "cac";
import type { RelatedCanon } from "@opencanon/runtime";
import { booleanOption, formatOption, positiveIntegerOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadProjectContext } from "./project.ts";
import {
  ConventionRenderKind,
  createPaths,
  conventionDocsReference,
  definitionTargetSummary,
  explainGlobMatches,
  fail,
  getChangedFiles,
  getGitFileHistory,
  matchesAny,
  resolveRootDir,
  splitList,
  toRepoRelativePath,
  unique,
  validateConfig,
} from "@opencanon/core";
import type { Convention } from "@opencanon/core";
import { Format } from "@opencanon/core";
import type { Validator } from "@opencanon/core";
import { RuntimeApiRoute, withRuntimeClient } from "./runtime-client.ts";
import type {
  ListSemanticChunksResult,
  ProjectContextAskResult,
  ProjectContextBacklinksResult,
  ProjectContextCoverageResult,
  ReadSemanticIndexStatusResult,
} from "@opencanon/core";

type Query = {
  files: string[];
  topics: string[];
  conventionIds: string[];
  explainFiles: string[];
  format: Format;
  check: boolean;
  changed: boolean;
  listTopics: boolean;
  listExceptions: boolean;
  explain: boolean;
  gitHistory: boolean;
  gitLimit: number;
  help: boolean;
};

type ContextValidator = Pick<Validator, "id" | "topics" | "appliesScopes" | "severity" | "scope" | "facts" | "conventionIds" | "docs" | "summary">;
type RelatedCanonRequest = {
  path: string;
  body?: {
    files: string[];
    topics: string[];
    conventionIds: string[];
  };
};
type ProjectContextQueryArgs = { help: true } | { help?: false; params: URLSearchParams; format: Format };

let rootDir = "";
let paths: ReturnType<typeof createPaths>;
const maxRelatedContextGetPathLength = 6000;
const projectContextSubcommands = new Set(["status", "chunks", "coverage", "backlinks"]);
const SemanticIndexReadinessStatus = {
  Ready: "ready",
} as const;
const removedProjectContextSubcommands: ReadonlyMap<string, string> = new Map([
  ["index", "opencanon project index"],
  ["search", "opencanon search <query>"],
  ["ask", "opencanon ask <question>"],
] as const);

export async function runContextCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  rootDir = resolveRootDir(cwd);
  paths = createPaths(rootDir);
  const removed = args[0] ? removedProjectContextSubcommands.get(args[0]) : undefined;
  if (removed) fail(`opencanon context ${args[0]} is no longer a command. Use ${removed}.`);
  if (args[0] && projectContextSubcommands.has(args[0])) {
    await runProjectContextSubcommand(args, cwd);
    return;
  }
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  assertValidConfig(paths);
  resolveChangedFiles(query);

  if (query.check) {
    try {
      await loadProjectContext(rootDir);
    } catch (error) {
      console.error("OpenCanon check failed:\n");
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
    console.log("OpenCanon check passed.");
    return;
  }

  const project = await loadProjectContext(rootDir);
  const conventions = project.conventions;

  if (query.listExceptions && query.changed && query.files.length === 0) {
    console.log("No changed files.");
    return;
  }

  if (query.listTopics) {
    const topics = listTopics(conventions);
    if (query.format === Format.Json) {
      writeJson({ topics });
      return;
    }
    console.log(topics.map((topic) => `- ${topic}`).join("\n"));
    return;
  }

  if (query.listExceptions) {
    const exceptions: unknown[] = [];
    if (query.format === Format.Json) {
      writeJson({ exceptions });
      return;
    }
    console.log(renderExceptionsMarkdown(exceptions));
    return;
  }

  if (query.explain) {
    const files = query.explainFiles.length > 0 ? query.explainFiles : query.files;
    if (files.length === 0) fail("--explain requires files, --files, or --changed.");
    const result = explainContext(conventions, project.validators, files);
    if (query.format === Format.Json) writeJson(result);
    else console.log(renderExplainMarkdown(result));
    return;
  }

  if (query.changed && query.files.length === 0 && query.topics.length === 0 && query.conventionIds.length === 0) {
    console.log("No changed files.");
    return;
  }

  if (query.files.length === 0 && query.topics.length === 0 && query.conventionIds.length === 0) {
    printHelp();
    process.exit(1);
  }

  const relatedRequest = contextRequest(query);
  const related = await withRuntimeClient(cwd, (client) =>
    relatedRequest.body ? client.post<RelatedCanon>(relatedRequest.path, relatedRequest.body) : client.get<RelatedCanon>(relatedRequest.path),
  );
  const result = {
    ...related,
    gitHistory: query.gitHistory && query.files.length > 0 ? getGitFileHistory(rootDir, query.files, query.gitLimit) : undefined,
  };
  if (query.format === Format.Json) {
    writeJson(result);
    return;
  }
  console.log(renderMarkdown(result));
}

export async function runAskCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  rootDir = resolveRootDir(cwd);
  paths = createPaths(rootDir);
  await runProjectContextAsk(args, cwd, "opencanon ask");
}

async function runProjectContextSubcommand(args: string[], cwd: string): Promise<void> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "status":
      await runProjectContextStatus(rest, cwd);
      return;
    case "chunks":
      await runProjectContextChunks(rest, cwd);
      return;
    case "coverage":
      await runProjectContextCoverage(rest, cwd);
      return;
    case "backlinks":
      await runProjectContextBacklinks(rest, cwd);
      return;
    default:
      fail(`Unknown context subcommand: ${subcommand}`);
  }
}

async function runProjectContextStatus(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon context status");
  cli.option("--format <format>", "Output format.");
  cli.option("-h, --help", "Show help.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["format", "help", "h"]);
  if (parsed.args.length > 0) fail(`Unexpected arguments: ${parsed.args.join(", ")}`);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printContextStatusHelp();
    return;
  }
  const result = await withRuntimeClient<ReadSemanticIndexStatusResult>(cwd, (client) => client.get(RuntimeApiRoute.ContextStatus));
  if (formatOption(options.format) === Format.Json) {
    writeJson(result);
    return;
  }
  console.log(renderProjectContextStatusMarkdown(result));
}

async function runProjectContextChunks(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon context chunks");
  cli.option("--file <path>", "Repository-relative file path.");
  cli.option("--path <path>", "Alias for --file.");
  cli.option("--definition <id>", "Definition id whose covered files should provide chunks.");
  cli.option("--limit <n>", "Maximum chunks.");
  cli.option("--offset <n>", "Chunk offset.");
  cli.option("--index", "Build Project Knowledge before listing chunks.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["file", "path", "definition", "limit", "offset", "index", "format"]);
  const params = new URLSearchParams();
  for (const file of [...stringValues(options.file), ...stringValues(options.path)]) params.append("path", toRepoRelativePath(rootDir, file));
  for (const definition of stringValues(options.definition)) params.append("definition", definition);
  params.set("limit", String(positiveIntegerOption(options.limit, "--limit", 50)));
  params.set("offset", String(nonNegativeIntegerOption(options.offset, "--offset", 0)));
  if (booleanOption(options.index)) params.set("index", "1");
  const format = formatOption(options.format);
  const result = await withRuntimeClient<ListSemanticChunksResult>(cwd, (client) => client.get(`${RuntimeApiRoute.ContextChunks}?${params.toString()}`));
  if (format === Format.Json) {
    writeJson(result);
    return;
  }
  console.log("# Project Knowledge Chunks\n");
  if (result.chunks.length === 0) {
    console.log("No chunks found.");
    return;
  }
  for (const chunk of result.chunks) {
    console.log(`- ${chunk.path}:${chunk.range.start.line} ${chunk.kind}${chunk.symbol ? ` ${chunk.symbol}` : ""}`);
    if (chunk.preview) console.log(`  ${chunk.preview}`);
  }
}

async function runProjectContextAsk(args: string[], cwd: string, command: string): Promise<void> {
  const parsed = parseProjectContextQueryArgs(command, args, { allowIndex: true });
  if (parsed.help) {
    printProjectContextQueryHelp(command, { allowIndex: true });
    return;
  }
  const result = await withRuntimeClient<ProjectContextAskResult>(cwd, (client) => client.get(`${RuntimeApiRoute.ContextAsk}?${parsed.params.toString()}`));
  if (parsed.format === Format.Json) {
    writeJson(result);
    return;
  }
  console.log(`# Project Knowledge Ask\n\nQuestion: ${result.question}\n`);
  if (result.warnings.length > 0) {
    console.log(result.warnings.map((warning) => `Warning: ${warning}`).join("\n"));
    console.log("");
  }
  console.log(result.answer);
  if (result.evidence.length > 0) {
    console.log("\nEvidence:");
    for (const [index, item] of result.evidence.entries()) console.log(`- [${index + 1}] ${item.file}:${item.line} ${item.preview}`);
  }
  if (result.suggestions.length > 0) {
    console.log("\nSuggestions:");
    for (const suggestion of result.suggestions) console.log(`- ${suggestion}`);
  }
}

async function runProjectContextCoverage(args: string[], cwd: string): Promise<void> {
  const parsed = parseContextCoverageArgs(args);
  if (parsed.help) {
    printContextCoverageHelp();
    return;
  }
  const params = new URLSearchParams();
  if (parsed.index) params.set("index", "1");
  const path = params.size > 0 ? `${RuntimeApiRoute.ContextCoverage}?${params.toString()}` : RuntimeApiRoute.ContextCoverage;
  const result = await withRuntimeClient<ProjectContextCoverageResult>(cwd, (client) => client.get(path));
  if (parsed.format === Format.Json) {
    writeJson(result);
    return;
  }
  console.log("# Project Knowledge Coverage\n");
  console.log(`Files: ${result.totals.files}`);
  console.log(`Governed: ${result.totals.governedFiles}`);
  console.log(`Ungoverned: ${result.totals.ungovernedFiles}`);
  console.log(`Indexed: ${result.totals.indexedFiles}`);
  console.log(`Chunks: ${result.totals.chunks}`);
  if (result.gaps.length > 0) {
    console.log("\nGaps:");
    for (const gap of result.gaps.slice(0, 25)) console.log(`- ${gap.message}`);
    if (result.gaps.length > 25) console.log(`- ... ${result.gaps.length - 25} more`);
  }
}

async function runProjectContextBacklinks(args: string[], cwd: string): Promise<void> {
  const parsed = parseProjectContextQueryArgs("opencanon context backlinks", args, { allowIndex: false });
  if (parsed.help) {
    printProjectContextQueryHelp("opencanon context backlinks", { allowIndex: false });
    return;
  }
  const result = await withRuntimeClient<ProjectContextBacklinksResult>(cwd, (client) => client.get(`${RuntimeApiRoute.ContextBacklinks}?${parsed.params.toString()}`));
  if (parsed.format === Format.Json) {
    writeJson(result);
    return;
  }
  console.log(`# Project Knowledge Backlinks\n\nQuery: ${result.query}`);
  if (result.links.length > 0) {
    console.log("\nDefinitions:");
    for (const link of result.links) console.log(`- ${link.kind}:${link.id}${link.title ? ` ${link.title}` : ""}`);
  }
  if (result.files.length > 0) {
    console.log("\nFiles:");
    for (const file of result.files) {
      const links = [...file.areas, ...file.specs, ...file.changes, ...file.conventions, ...file.surfaces].map((link) => `${link.kind}:${link.id}`);
      console.log(`- ${file.file}${links.length > 0 ? ` -> ${links.join(", ")}` : ""}`);
    }
  }
  if (result.links.length === 0 && result.files.length === 0) console.log("\nNo backlinks found.");
}

function parseProjectContextQueryArgs(command: string, args: string[], input: { allowIndex: boolean }): ProjectContextQueryArgs {
  const cli = cac(command);
  cli.option("-h, --help", "Show help.");
  cli.option("--limit <n>", "Maximum results.");
  cli.option("--path <path>", "Repository-relative path filter.");
  cli.option("--file <path>", "Alias for --path.");
  if (input.allowIndex) cli.option("--index", "Build Project Knowledge before querying.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, input.allowIndex ? ["help", "h", "limit", "path", "file", "index", "format"] : ["help", "h", "limit", "path", "file", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) return { help: true };
  const query = parsed.args.map(String).join(" ").trim();
  if (!query) fail(`${command} requires a query.`);
  const params = new URLSearchParams();
  params.set("query", query);
  params.set("limit", String(positiveIntegerOption(options.limit, "--limit", 20)));
  for (const file of [...stringValues(options.path), ...stringValues(options.file)]) params.append("path", toRepoRelativePath(rootDir, file));
  if (input.allowIndex && booleanOption(options.index)) params.set("index", "1");
  return { params, format: formatOption(options.format) };
}

function parseContextCoverageArgs(args: string[]): { help: true } | { help?: false; format: Format; index: boolean } {
  const cli = cac("opencanon context coverage");
  cli.option("-h, --help", "Show help.");
  cli.option("--index", "Build Project Knowledge before computing coverage.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["format", "index", "help", "h"]);
  if (booleanOption(options.help) || booleanOption(options.h)) return { help: true };
  if (parsed.args.length > 0) fail(`Unexpected arguments: ${parsed.args.join(", ")}`);
  return { format: formatOption(options.format), index: booleanOption(options.index) };
}

function nonNegativeIntegerOption(value: unknown, name: string, fallback: number): number {
  if (value === undefined || value === false) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) fail(`${name} must be a non-negative integer.`);
  return parsed;
}

function assertValidConfig(paths: ReturnType<typeof createPaths>): void {
  const diagnostics = validateConfig(paths);
  if (diagnostics.length === 0) return;
  console.error("OpenCanon config is invalid:\n");
  for (const diagnostic of diagnostics) console.error(`- ${diagnostic}`);
  process.exit(1);
}

function parseArgs(args: string[]): Query {
  const cli = cac("opencanon");
  cli.option("-h, --help", "Show help.");
  cli.option("--check", "Validate context docs and conventions.");
  cli.option("--list-topics", "List available topics.");
  cli.option("--list-exceptions", "List documented convention exceptions.");
  cli.option("--changed", "Use changed Git files.");
  cli.option("--git-history", "Include recent commits for selected files.");
  cli.option("--git-limit <n>", "Number of commits per file.");
  cli.option("--explain", "Explain why files match context.");
  cli.option("--format <format>", "Output format.");
  cli.option("--topic <topic>", "Load context for one topic.");
  cli.option("--topics <topics>", "Load context for topics.");
  cli.option("--convention <id>", "Include a specific convention by id.");
  cli.option("--files <path>", "Resolve topics from a file path.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [
    "help",
    "h",
    "check",
    "listTopics",
    "listExceptions",
    "changed",
    "gitHistory",
    "gitLimit",
    "explain",
    "format",
    "topic",
    "topics",
    "convention",
    "files",
  ]);

  const files = unique([...stringValues(options.files), ...parsed.args.map(String)].map((file) => toRepoRelativePath(rootDir, file)));
  const topics = unique([...stringValues(options.topic), ...stringValues(options.topics)].flatMap(splitList));
  const conventionIds = unique(stringValues(options.convention).flatMap(splitList));

  const query: Query = {
    files,
    topics,
    conventionIds,
    explainFiles: booleanOption(options.explain) ? files : [],
    format: formatOption(options.format),
    check: booleanOption(options.check),
    changed: booleanOption(options.changed),
    listTopics: booleanOption(options.listTopics),
    listExceptions: booleanOption(options.listExceptions),
    explain: booleanOption(options.explain),
    gitHistory: booleanOption(options.gitHistory),
    gitLimit: positiveIntegerOption(options.gitLimit, "--git-limit", 5),
    help: booleanOption(options.help) || booleanOption(options.h),
  };
  return query;
}

function resolveChangedFiles(query: Query): void {
  if (!query.changed) return;
  const result = getChangedFiles(rootDir);
  if (!result.gitRoot) fail(result.diagnostics.join("\n"));
  query.files = unique([...query.files, ...result.files]);
}

function contextRequest(query: Query): RelatedCanonRequest {
  const params = new URLSearchParams();
  for (const file of query.files) params.append("file", file);
  for (const topic of query.topics) params.append("topic", topic);
  for (const conventionId of query.conventionIds) params.append("conventionId", conventionId);
  const search = params.toString();
  const path = search ? `${RuntimeApiRoute.CanonRelated}?${search}` : RuntimeApiRoute.CanonRelated;
  if (path.length <= maxRelatedContextGetPathLength) return { path };
  return {
    path: RuntimeApiRoute.CanonRelated,
    body: {
      files: query.files,
      topics: query.topics,
      conventionIds: query.conventionIds,
    },
  };
}

function explainContext(conventions: Convention[], validators: ContextValidator[], files: string[]) {
  return {
    root: rootDir,
    files: files.map((file) => ({
      file,
      conventions: conventions
        .filter((convention) => matchesAny(file, conventionApplies(convention)))
        .map((convention) => ({
          id: convention.id,
          title: convention.title,
          topics: convention.topics ?? [],
          docs: convention.render.kind === ConventionRenderKind.None ? [] : [conventionDocsReference(convention)!],
          matchedPatterns: matchedPatterns(file, conventionApplies(convention)),
          allPatterns: explainGlobMatches(file, conventionApplies(convention)),
        })),
      validators: validators
        .filter((validator) => validatorMatchesFileMetadata(validator, file))
        .map((validator) => ({
          id: validator.id,
          topics: validator.topics,
          severity: validator.severity,
          scope: validator.scope,
          facts: validator.facts,
          summary: validator.summary,
          docs: validator.docs,
          matchedPatterns: matchedValidatorPatterns(file, validator),
          allPatterns: validator.appliesScopes.flatMap((patterns) => explainGlobMatches(file, patterns)),
        })),
    })),
  };
}

function renderExplainMarkdown(result: ReturnType<typeof explainContext>): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Explain");
  lines.push("");

  for (const file of result.files) {
    lines.push(`## ${file.file}`);
    lines.push("");
    pushExplainGroup(lines, "Conventions", file.conventions);
    pushExplainGroup(lines, "Validators", file.validators);
  }

  return lines.join("\n").trimEnd();
}

function pushExplainGroup(
  lines: string[],
  title: string,
  items: Array<{
    id: string;
    source?: string;
    matchedPatterns: string[];
    topics: string[];
    severity?: string;
    scope?: string;
    facts?: string[];
    docs?: string[];
    title?: string;
    summary?: string;
  }>,
): void {
  lines.push(`${title}:`);
  if (items.length === 0) {
    lines.push("- none");
    lines.push("");
    return;
  }

  for (const item of items) {
    const label = item.title ? `${item.id}: ${item.title}` : item.id;
    lines.push(`- ${label}`);
    if (item.summary) lines.push(`  Summary: ${item.summary}`);
    if (item.severity) lines.push(`  Severity: ${item.severity}`);
    if (item.scope) lines.push(`  Scope: ${item.scope}`);
    if (item.facts) lines.push(`  Facts: ${item.facts.join(", ") || "<none>"}`);
    if (item.docs && item.docs.length > 0) lines.push(`  Docs: ${item.docs.join(", ")}`);
    lines.push(`  Topics: ${item.topics.join(", ")}`);
    if (item.source) lines.push(`  Source: ${item.source}`);
    lines.push(`  Via: ${item.matchedPatterns.join(", ")}`);
  }
  lines.push("");
}

function renderMarkdown(result: RelatedCanon & { gitHistory?: ReturnType<typeof getGitFileHistory> }): string {
  const lines: string[] = [];
  lines.push("# OpenCanon");
  lines.push("");

  if (result.query.files.length > 0) {
    lines.push("Files:");
    for (const file of result.query.files) lines.push(`- ${file}`);
    lines.push("");
  }

  if (result.matchedTopics.length > 0) {
    lines.push("Matched topics:");
    for (const topic of result.matchedTopics) lines.push(`- ${topic}`);
  } else {
    lines.push("No topics matched.");
  }
  lines.push("");

  lines.push("Standing agent policy:");
  lines.push("- Treat returned docs and conventions as source of truth.");
  lines.push("- If touched code uses a replaced pattern, refactor the touched flow to the current pattern.");
  lines.push("- Do not add internal shims, aliases, compatibility wrappers, deprecated paths, or parallel APIs.");
  lines.push("");

  if (result.docs.length > 0) {
    lines.push("## Referenced Docs");
    lines.push("");
    for (const doc of result.docs) {
      lines.push(`Source: ${doc.source}`);
      lines.push("");
      lines.push(doc.body);
      lines.push("");
    }
  }

  if (result.areas.length > 0) {
    lines.push("## Areas");
    lines.push("");
    for (const area of result.areas) {
      lines.push(`### ${area.title}`);
      lines.push("");
      lines.push(`Id: ${area.id}`);
      lines.push(`Summary: ${area.summary}`);
      lines.push(`Render: ${area.render}`);
      if (area.surfaces.length > 0) lines.push(`Impact surfaces: ${area.surfaces.join(", ")}`);
      if (area.docs.length > 0) lines.push(`Docs: ${area.docs.join(", ")}`);
      if (area.checks.length > 0) lines.push(`Checks: ${area.checks.map((check) => `${check.id} (${check.kind})`).join(", ")}`);
      lines.push(`Source: ${area.source}`);
      lines.push("");
    }
  }

  if (result.changes.length > 0) {
    lines.push("## Active Changes");
    lines.push("");
    for (const change of result.changes) {
      lines.push(`### ${change.title}`);
      lines.push("");
      lines.push(`Id: ${change.id}`);
      lines.push(`Kind: ${change.kind}`);
      lines.push(`Board: ${change.boardColumn}`);
      lines.push(`Summary: ${change.summary}`);
      lines.push(`Problem: ${change.intent.problem}`);
      lines.push(`Outcome: ${change.intent.outcome}`);
      if (change.lastEvent) lines.push(`Last event: ${change.lastEvent.type} - ${change.lastEvent.summary}`);
      pushList(lines, "Updates", [
        ...change.updates.areas.map((id) => `area: ${id}`),
        ...change.updates.conventions.map((id) => `convention: ${id}`),
        ...change.updates.surfaces.map((id) => `surface: ${id}`),
      ]);
      pushList(lines, "Scope", [
        ...change.scope.map((target) => `${target.kind}: ${definitionTargetSummary(target)}`),
      ]);
      if (change.docs.length > 0) lines.push(`Docs: ${change.docs.join(", ")}`);
      if (change.checks.length > 0) lines.push(`Checks: ${change.checks.map((check) => `${check.id} (${check.kind})`).join(", ")}`);
      lines.push(`Source: ${change.source}`);
      lines.push("");
    }
  }

  if (result.conventions.length > 0) {
    lines.push("## Conventions");
    lines.push("");
    for (const convention of result.conventions) {
      lines.push(`### ${convention.title}`);
      lines.push("");
      lines.push(`Id: ${convention.id}`);
      lines.push(`Topics: ${(convention.topics ?? []).join(", ")}`);
      lines.push(`Applies: ${convention.applies.join(", ")}`);
      if (convention.related && convention.related.length > 0) lines.push(`Related: ${convention.related.join(", ")}`);
      if (convention.docs && convention.docs.length > 0) lines.push(`Docs: ${convention.docs.join(", ")}`);
      lines.push("");
      lines.push(convention.rule);
      lines.push("");
      pushList(lines, "Why", convention.why ? [convention.why] : []);
    }
  }

  if (result.gitHistory) {
    lines.push("## Git Context");
    lines.push("");
    lines.push("Use this as historical evidence, not as source of truth.");
    lines.push("");
    for (const history of result.gitHistory.histories) {
      lines.push(`### ${history.file}`);
      if (history.commits.length === 0) {
        lines.push("- No commits found for this file.");
      } else {
        for (const commit of history.commits) lines.push(`- ${commit.hash} ${commit.date} ${commit.subject}`);
      }
      for (const diagnostic of history.diagnostics) lines.push(`- ${diagnostic}`);
      lines.push("");
    }
    for (const diagnostic of result.gitHistory.diagnostics) lines.push(`- ${diagnostic}`);
  }

  if (result.validators.length > 0) {
    lines.push("## Available Validators");
    lines.push("");
    for (const validator of result.validators) {
      lines.push(`- ${validator.id} (${validator.severity})`);
      if (validator.summary) lines.push(`  Summary: ${validator.summary}`);
      lines.push(`  Scope: ${validator.scope}`);
      lines.push(`  Facts: ${validator.facts.join(", ") || "<none>"}`);
      lines.push(`  Topics: ${validator.topics.join(", ")}`);
      lines.push(`  Applies: ${validator.applies.join(", ")}`);
      if (validator.conventionIds.length > 0) lines.push(`  Conventions: ${validator.conventionIds.join(", ")}`);
      if (validator.docs.length > 0) lines.push(`  Docs: ${validator.docs.join(", ")}`);
    }
    lines.push("");
    lines.push("Run:");
    lines.push("");
    lines.push("```bash");
    lines.push("opencanon validate --files <paths...>");
    lines.push("```");
  }

  return lines.join("\n").trimEnd();
}

function renderExceptionsMarkdown(exceptions: unknown[]): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Exceptions");
  lines.push("");

  if (exceptions.length === 0) {
    lines.push("No documented exceptions matched.");
    return lines.join("\n");
  }

  return lines.join("\n").trimEnd();
}

function pushList(lines: string[], title: string, items: string[] | undefined): void {
  if (!items || items.length === 0) return;
  lines.push(`${title}:`);
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
}

function listTopics(conventions: Convention[]): string[] {
  return unique(conventions.flatMap((convention) => convention.topics ?? [])).sort();
}

function conventionApplies(convention: Convention): string[] {
  switch (convention.applies.kind) {
    case "files":
    case "symbols":
      return convention.applies.globs;
    case "imports":
      return [...(convention.applies.from ?? []), ...(convention.applies.to ?? [])];
    case "impact-surface":
      return convention.applies.surfaceIds;
    case "definitions":
      return convention.applies.definitions.flatMap((target) => (target.ids ?? ["*"]).map((id) => `${target.kind}:${id}`));
    case "project":
      return [convention.applies.describe ?? "project"];
    case "custom":
      return [convention.applies.describe];
  }
}

function matchedPatterns(file: string, patterns: string[]): string[] {
  return explainGlobMatches(file, patterns)
    .filter((item) => item.matched)
    .map((item) => item.pattern);
}

function matchedValidatorPatterns(file: string, validator: ContextValidator): string[] {
  if (validator.appliesScopes.length === 0) return ["<project>"];
  return validator.appliesScopes.flatMap((patterns) => matchedPatterns(file, patterns));
}

function validatorMatchesFileMetadata(validator: ContextValidator, file: string): boolean {
  return validator.appliesScopes.length === 0 || validator.appliesScopes.every((patterns) => matchesAny(file, patterns));
}

function writeJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function renderProjectContextStatusMarkdown(result: ReadSemanticIndexStatusResult): string {
  const lines = ["# Project Knowledge Status", ""];
  if (!result.index) {
    lines.push("Status: missing", "", "Action: Run opencanon project index to build Project Knowledge for Search, Ask, Chunks, and Coverage.");
    return lines.join("\n");
  }
  lines.push(`Status: ${result.index.status}`);
  lines.push(`Chunks: ${result.index.chunkCount}`);
  lines.push(`Vectors: ${result.index.vectorCount}`);
  lines.push(`Stale chunks: ${result.index.staleChunkCount}`);
  lines.push(`Provider: ${result.index.provider.displayName ?? result.index.provider.id} (${result.index.provider.modelId})`);
  lines.push(`Indexed: ${result.index.indexedAt}`);
  if (result.index.embeddingStats) {
    lines.push(`Embeddings: ${result.index.embeddingStats.embeddedChunks} embedded, ${result.index.embeddingStats.reusedChunks} reused of ${result.index.embeddingStats.totalChunks}`);
    lines.push(`Files: ${result.index.embeddingStats.filesScanned ?? 0} scanned, ${result.index.embeddingStats.filesChanged ?? 0} changed, ${result.index.embeddingStats.filesDeleted ?? 0} deleted`);
    lines.push(`Chunks: ${result.index.embeddingStats.chunksAdded ?? 0} added, ${result.index.embeddingStats.chunksChanged ?? 0} changed, ${result.index.embeddingStats.chunksRemoved ?? 0} removed`);
    lines.push(`Vectors: ${result.index.embeddingStats.vectorsWritten ?? result.index.embeddingStats.embeddedChunks} written, ${result.index.embeddingStats.vectorsReused ?? result.index.embeddingStats.reusedChunks} reused`);
  }
  if (result.index.diagnostics.length > 0) {
    lines.push("", "Diagnostics:");
    for (const diagnostic of result.index.diagnostics) lines.push(`- ${diagnostic.severity}: ${diagnostic.message}`);
  }
  if (result.index.status !== SemanticIndexReadinessStatus.Ready || result.index.staleChunkCount > 0) {
    lines.push("", "Action: Run opencanon project index to build Project Knowledge for Search, Ask, Chunks, and Coverage.");
  }
  return lines.join("\n");
}

function printHelp(): void {
  console.log(`Usage:
  opencanon context --files <paths...>
  opencanon context --topic <topic>
  opencanon context --convention <id>
  opencanon context --changed
  opencanon context --explain <paths...>
  opencanon context --explain --changed
  opencanon context --list-topics
  opencanon context --list-exceptions
  opencanon context --check
  opencanon context status
  opencanon context chunks --file src/auth.ts
  opencanon context chunks --definition project-knowledge-index
  opencanon context coverage
  opencanon context backlinks project-knowledge-index

Options:
  --format markdown|json   Output format. Default: markdown.
  --files <paths...>       Resolve topics from file globs.
  --changed                Use changed Git files.
  --list-topics            List available topics.
  --list-exceptions        List documented convention exceptions.
  --explain <paths...>     Explain why files match conventions and validators.
  --git-history            Include recent commits for selected files.
  --git-limit <n>          Number of commits per file. Default: 5.
  --topic <topic>          Load context for one topic. Repeat or comma-separate.
  --convention <id>        Include a specific convention by id.
`);
}

function printContextStatusHelp(): void {
  console.log(`Usage:
  opencanon context status
  opencanon context status --format json

Options:
  --format markdown|json   Output format. Default: markdown.
`);
}

function printContextCoverageHelp(): void {
  console.log(`Usage:
  opencanon context coverage
  opencanon context coverage --index
  opencanon context coverage --format json

Options:
  --index                  Build Project Knowledge before computing coverage.
  --format markdown|json   Output format. Default: markdown.
`);
}

function printProjectContextQueryHelp(command: string, input: { allowIndex: boolean }): void {
  const indexLine = input.allowIndex ? "  --index                  Build Project Knowledge before querying.\n" : "";
  console.log(`Usage:
  ${command} <query>
  ${command} <query> --path src/auth.ts
  ${command} <query> --limit 20 --format json

Options:
  --limit <n>          Maximum results. Default: 20.
  --path <path>        Repository-relative path filter. Repeatable.
  --file <path>        Alias for --path.
${indexLine}  --format markdown|json   Output format. Default: markdown.
`);
}
