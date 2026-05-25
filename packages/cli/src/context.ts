import { cac } from "cac";
import type { RelatedCanon } from "@opencanon/daemon";
import { booleanOption, formatOption, positiveIntegerOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadValidators } from "./project.ts";
import {
  createPaths,
  explainGlobMatches,
  fail,
  getChangedFiles,
  getGitFileHistory,
  intersects,
  loadContextFiles,
  loadImpactSurfaces,
  matchesAny,
  matchesAnyFile,
  relative,
  resolveRootDir,
  splitList,
  toRepoRelativePath,
  unique,
  validateConfig,
  validateContext,
} from "@opencanon/core";
import type { Decision, Format } from "@opencanon/core";
import type { Validator } from "@opencanon/core";
import { DaemonApiRoute, withDaemonClient } from "./daemon-client.ts";

type Query = {
  files: string[];
  topics: string[];
  decisionIds: string[];
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

type ContextValidator = Pick<Validator, "id" | "topics" | "appliesScopes" | "severity" | "scope" | "facts" | "decisionIds" | "docs" | "summary">;

let rootDir = "";
let paths: ReturnType<typeof createPaths>;

export async function runContextCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  rootDir = resolveRootDir(cwd);
  paths = createPaths(rootDir);
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  assertValidConfig(paths);
  resolveChangedFiles(query);

  if (query.check) {
    const { decisions } = loadContextFiles(paths);
    const { surfaces: impactSurfaces, diagnostics: impactDiagnostics } = loadImpactSurfaces(paths);
    const validators = await loadValidators(rootDir, paths);
    const diagnostics = [...impactDiagnostics, ...validateContext({ decisions, validators, impactSurfaces, paths })];
    if (diagnostics.length > 0) {
      console.error("OpenCanon check failed:\n");
      for (const diagnostic of diagnostics) console.error(`- ${diagnostic}`);
      process.exit(1);
    }
    console.log("OpenCanon check passed.");
    return;
  }

  const { decisions } = loadContextFiles(paths);

  if (query.listExceptions && query.changed && query.files.length === 0) {
    console.log("No changed files.");
    return;
  }

  if (query.listTopics) {
    const topics = listTopics(decisions);
    if (query.format === "json") {
      writeJson({ topics });
      return;
    }
    console.log(topics.map((topic) => `- ${topic}`).join("\n"));
    return;
  }

  if (query.listExceptions) {
    const exceptions = selectExceptions(decisions, query);
    if (query.format === "json") {
      writeJson({ exceptions });
      return;
    }
    console.log(renderExceptionsMarkdown(exceptions));
    return;
  }

  if (query.explain) {
    const validators = await loadValidators(rootDir, paths);
    const files = query.explainFiles.length > 0 ? query.explainFiles : query.files;
    if (files.length === 0) fail("--explain requires files, --files, or --changed.");
    const result = explainContext(decisions, validators, files);
    if (query.format === "json") writeJson(result);
    else console.log(renderExplainMarkdown(result));
    return;
  }

  if (query.changed && query.files.length === 0 && query.topics.length === 0 && query.decisionIds.length === 0) {
    console.log("No changed files.");
    return;
  }

  if (query.files.length === 0 && query.topics.length === 0 && query.decisionIds.length === 0) {
    printHelp();
    process.exit(1);
  }

  const related = await withDaemonClient(cwd, (client) => client.get<RelatedCanon>(contextRoute(query)));
  const result = {
    ...related,
    gitHistory: query.gitHistory && query.files.length > 0 ? getGitFileHistory(rootDir, query.files, query.gitLimit) : undefined,
  };
  if (query.format === "json") {
    writeJson(result);
    return;
  }
  console.log(renderMarkdown(result));
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
  cli.option("--check", "Validate context docs and decisions.");
  cli.option("--list-topics", "List available topics.");
  cli.option("--list-exceptions", "List documented decision exceptions.");
  cli.option("--changed", "Use changed Git files.");
  cli.option("--git-history", "Include recent commits for selected files.");
  cli.option("--git-limit <n>", "Number of commits per file.");
  cli.option("--explain", "Explain why files match context.");
  cli.option("--format <format>", "Output format.");
  cli.option("--topic <topic>", "Load context for one topic.");
  cli.option("--topics <topics>", "Load context for topics.");
  cli.option("--decision <id>", "Include a specific decision by id.");
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
    "decision",
    "files",
  ]);

  const files = unique([...stringValues(options.files), ...parsed.args.map(String)].map((file) => toRepoRelativePath(rootDir, file)));
  const topics = unique([...stringValues(options.topic), ...stringValues(options.topics)].flatMap(splitList));
  const decisionIds = unique(stringValues(options.decision).flatMap(splitList));

  const query: Query = {
    files,
    topics,
    decisionIds,
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

function selectExceptions(decisions: Decision[], query: Query) {
  const filtered = decisions.filter((decision) => {
    const hasFilters = query.files.length > 0 || query.topics.length > 0 || query.decisionIds.length > 0;
    if (!hasFilters) return true;
    return query.decisionIds.includes(decision.id) || intersects(decision.topics, query.topics) || matchesAnyFile(query.files, decision.applies);
  });

  return filtered
    .filter((decision) => decision.exceptions && decision.exceptions.length > 0)
    .map((decision) => ({
      id: decision.id,
      title: decision.title,
      status: decision.status,
      topics: decision.topics,
      applies: decision.applies,
      exceptions: decision.exceptions ?? [],
      source: `${relative(rootDir, paths.decisionsPath)}#${decision.id}`,
    }));
}

function resolveChangedFiles(query: Query): void {
  if (!query.changed) return;
  const result = getChangedFiles(rootDir);
  if (!result.gitRoot) fail(result.diagnostics.join("\n"));
  query.files = unique([...query.files, ...result.files]);
}

function contextRoute(query: Query): string {
  const params = new URLSearchParams();
  for (const file of query.files) params.append("file", file);
  for (const topic of query.topics) params.append("topic", topic);
  for (const decisionId of query.decisionIds) params.append("decisionId", decisionId);
  const search = params.toString();
  return search ? `${DaemonApiRoute.CanonRelated}?${search}` : DaemonApiRoute.CanonRelated;
}

function explainContext(decisions: Decision[], validators: ContextValidator[], files: string[]) {
  return {
    root: rootDir,
    files: files.map((file) => ({
      file,
      decisions: decisions
        .filter((decision) => matchesAny(file, decision.applies))
        .map((decision) => ({
          id: decision.id,
          title: decision.title,
          topics: decision.topics,
          docs: decision.docs ?? [],
          source: `${relative(rootDir, paths.decisionsPath)}#${decision.id}`,
          matchedPatterns: matchedPatterns(file, decision.applies),
          allPatterns: explainGlobMatches(file, decision.applies),
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
    pushExplainGroup(lines, "Decisions", file.decisions);
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
  lines.push("- Treat returned docs and decisions as source of truth.");
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

  if (result.decisions.length > 0) {
    lines.push("## Pattern Decisions");
    lines.push("");
    for (const decision of result.decisions) {
      lines.push(`### ${decision.date}: ${decision.title}`);
      lines.push("");
      lines.push(`Source: ${decision.source}`);
      lines.push(`Status: ${decision.status}`);
      lines.push(`Topics: ${decision.topics.join(", ")}`);
      lines.push(`Applies: ${decision.applies.join(", ")}`);
      if (decision.validatorIds && decision.validatorIds.length > 0) lines.push(`Validators: ${decision.validatorIds.join(", ")}`);
      if (decision.docs && decision.docs.length > 0) lines.push(`Docs: ${decision.docs.join(", ")}`);
      lines.push("");
      lines.push(decision.summary);
      lines.push("");
      pushList(lines, "Rationale", decision.rationale);
      pushList(lines, "Required", decision.required);
      pushList(lines, "Replaced", decision.replaced);
      pushList(lines, "Agent Policy", decision.agentPolicy);
      pushList(lines, "Exceptions", decision.exceptions);
      pushList(lines, "Examples", decision.examples);
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
      if (validator.decisionIds.length > 0) lines.push(`  Decisions: ${validator.decisionIds.join(", ")}`);
      if (validator.docs.length > 0) lines.push(`  Docs: ${validator.docs.join(", ")}`);
    }
    lines.push("");
    lines.push("Run:");
    lines.push("");
    lines.push("```bash");
    lines.push("bun run opencanon validate --files <paths...>");
    lines.push("```");
  }

  return lines.join("\n").trimEnd();
}

function renderExceptionsMarkdown(exceptions: ReturnType<typeof selectExceptions>): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Exceptions");
  lines.push("");

  if (exceptions.length === 0) {
    lines.push("No documented exceptions matched.");
    return lines.join("\n");
  }

  for (const decision of exceptions) {
    lines.push(`## ${decision.id}: ${decision.title}`);
    lines.push("");
    lines.push(`Source: ${decision.source}`);
    lines.push(`Status: ${decision.status}`);
    lines.push(`Topics: ${decision.topics.join(", ")}`);
    lines.push(`Applies: ${decision.applies.join(", ")}`);
    lines.push("");
    for (const exception of decision.exceptions) lines.push(`- ${exception}`);
    lines.push("");
  }

  return lines.join("\n").trimEnd();
}

function pushList(lines: string[], title: string, items: string[] | undefined): void {
  if (!items || items.length === 0) return;
  lines.push(`${title}:`);
  for (const item of items) lines.push(`- ${item}`);
  lines.push("");
}

function listTopics(decisions: Decision[]): string[] {
  return unique(decisions.flatMap((decision) => decision.topics)).sort();
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

function printHelp(): void {
  console.log(`Usage:
  bun run opencanon context --files <paths...>
  bun run opencanon context --topic <topic>
  bun run opencanon context --decision <id>
  bun run opencanon context --changed
  bun run opencanon context --explain <paths...>
  bun run opencanon context --explain --changed
  bun run opencanon context --list-topics
  bun run opencanon context --list-exceptions
  bun run opencanon context --check

Options:
  --format markdown|json   Output format. Default: markdown.
  --files <paths...>       Resolve topics from file globs.
  --changed                Use changed Git files.
  --list-topics            List available topics.
  --list-exceptions        List documented decision exceptions.
  --explain <paths...>     Explain why files match decisions and validators.
  --git-history            Include recent commits for selected files.
  --git-limit <n>          Number of commits per file. Default: 5.
  --topic <topic>          Load context for one topic. Repeat or comma-separate.
  --decision <id>          Include a specific decision by id.
`);
}
