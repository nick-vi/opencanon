import { splitList, unique } from "@opencanon/core";
import type { Format } from "@opencanon/core";
import { createPaths, formatValidatorApplies, resolveRootDir } from "@opencanon/core";
import type { Validator, ValidatorVisual } from "@opencanon/core";
import type { TreeBoundaryRule, TreeDefinition, TreeNode, TreePathDefinition } from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import { loadValidators } from "./project.ts";
import { existsSync } from "node:fs";
import { cac } from "cac";
import path from "node:path";

type RuleQuery = {
  topics: string[];
  validatorIds: string[];
  decisionIds: string[];
  format: Format;
  tree: boolean;
  ascii: boolean;
  color: boolean;
  help: boolean;
};

type RuleSummary = {
  id: string;
  severity: Validator["severity"];
  scope: Validator["scope"];
  facts: Validator["facts"];
  analysis: string[];
  summary?: string;
  topics: string[];
  applies: string[];
  decisionIds: string[];
  docs: string[];
  fixtures: {
    valid: boolean;
    invalid: boolean;
    fixed: boolean;
  };
  visuals: ValidatorVisual[];
  command: string;
};

type RuleValidator = Pick<Validator, "id" | "severity" | "scope" | "facts" | "analysisGlobs" | "summary" | "topics" | "appliesScopes" | "decisionIds" | "docs"> & {
  visuals: unknown[];
};

type TreeRenderOptions = {
  ascii: boolean;
  color: boolean;
};

type BoundaryGraphItem = {
  label: string;
  children?: BoundaryGraphItem[];
};

export async function runRulesCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const query = parseArgs(args);
  if (query.help) {
    printHelp();
    return;
  }

  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const validators = await loadValidators(rootDir, paths);
  const selectedValidators = selectRuleValidators(validators, {
    topics: query.topics,
    validatorIds: query.validatorIds,
    decisionIds: query.decisionIds,
  });
  const rules = selectedValidators.map((validator) => summarizeRule(paths.fixturesDir, validator));

  if (query.format === "json") console.log(JSON.stringify({ validators: rules }, null, 2));
  else if (query.tree) console.log(renderRuleTreesMarkdown(rules, { ascii: query.ascii, color: query.color }));
  else console.log(renderRulesMarkdown(rules));
}

function parseArgs(args: string[]): RuleQuery {
  const cli = cac("opencanon rules");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--topic <topic>", "Show validators for a topic.");
  cli.option("--topics <topics>", "Show validators for topics.");
  cli.option("--validator <id>", "Show one validator.");
  cli.option("--decision <id>", "Show validators linked to a decision.");
  cli.option("--tree", "Render tree visualizations for matching validators.");
  cli.option("--ascii", "Use ASCII tree lines.");
  cli.option("--no-color", "Disable ANSI colors.");

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format", "topic", "topics", "validator", "decision", "tree", "ascii", "color"]);

  return {
    topics: unique([...stringValues(options.topic), ...stringValues(options.topics)].flatMap(splitList)),
    validatorIds: unique([...stringValues(options.validator), ...parsed.args.map(String)].flatMap(splitList)),
    decisionIds: unique(stringValues(options.decision).flatMap(splitList)),
    format: formatOption(options.format),
    tree: booleanOption(options.tree),
    ascii: booleanOption(options.ascii),
    color: options.color === false ? false : Boolean(process.stdout.isTTY && !process.env.NO_COLOR),
    help: options.help === true || options.h === true,
  };
}

function summarizeRule(fixturesDir: string, validator: RuleValidator): RuleSummary {
  return {
    id: validator.id,
    severity: validator.severity,
    scope: validator.scope,
    facts: validator.facts,
    analysis: validator.analysisGlobs,
    summary: validator.summary,
    topics: validator.topics,
    applies: formatValidatorApplies(validator as Validator),
    decisionIds: validator.decisionIds,
    docs: validator.docs,
    fixtures: {
      valid: hasFixtureFiles(fixturesDir, validator.id, "valid"),
      invalid: hasFixtureFiles(fixturesDir, validator.id, "invalid"),
      fixed: hasFixtureFiles(fixturesDir, validator.id, "fixed"),
    },
    visuals: validator.visuals.filter(isValidatorVisual),
    command: `bun run opencanon validate --validator ${validator.id} --project`,
  };
}

function isValidatorVisual(value: unknown): value is ValidatorVisual {
  if (!isRecord(value) || value.kind !== "tree") return false;
  return isRecord(value.definition);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function selectRuleValidators(validators: RuleValidator[], query: { topics: string[]; validatorIds: string[]; decisionIds: string[] }): RuleValidator[] {
  if (query.validatorIds.length === 0 && query.topics.length === 0 && query.decisionIds.length === 0) return validators;
  return validators.filter(
    (validator) =>
      query.validatorIds.includes(validator.id) || intersectsAny(validator.topics, query.topics) || intersectsAny(validator.decisionIds, query.decisionIds),
  );
}

function intersectsAny(left: string[], right: string[]): boolean {
  return left.some((item) => right.includes(item));
}

function hasFixtureFiles(fixturesDir: string, validatorId: string, fixtureCase: string): boolean {
  return existsSync(path.join(fixturesDir, validatorId, `${fixtureCase}.ts`));
}

function renderRulesMarkdown(rules: RuleSummary[]): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Rules");
  lines.push("");
  lines.push(`Validators: ${rules.length}`);

  if (rules.length === 0) {
    lines.push("");
    lines.push("No validators matched.");
    return lines.join("\n");
  }

  for (const rule of rules) {
    lines.push("");
    lines.push(`## ${rule.id} [${rule.severity}]`);
    if (rule.summary) lines.push(`Summary: ${rule.summary}`);
    lines.push(`Scope: ${rule.scope}`);
    lines.push(`Facts: ${rule.facts.join(", ") || "<none>"}`);
    lines.push(`Analysis: ${rule.analysis.join(", ") || "<target files>"}`);
    lines.push(`Topics: ${rule.topics.join(", ") || "<none>"}`);
    lines.push(`Applies: ${rule.applies.join("; ")}`);
    lines.push(`Decisions: ${rule.decisionIds.join(", ") || "<none>"}`);
    lines.push(`Docs: ${(rule.docs ?? []).join(", ") || "<none>"}`);
    lines.push(`Fixtures: ${fixtureLabels(rule.fixtures).join(", ") || "none"}`);
    if (rule.visuals.length > 0) lines.push(`Visuals: ${rule.visuals.map((visual) => visual.kind).join(", ")}`);
    lines.push(`Run: \`${rule.command}\``);
  }

  return lines.join("\n");
}

function renderRuleTreesMarkdown(rules: RuleSummary[], options: TreeRenderOptions): string {
  const lines: string[] = [];
  const treeRules = rules
    .map((rule) => ({ rule, visuals: rule.visuals.filter((visual) => visual.kind === "tree") }))
    .filter((item) => item.visuals.length > 0);
  const color = colorFns(options.color);

  lines.push("# OpenCanon Rule Trees");
  lines.push("");
  lines.push(`Validators: ${treeRules.length}`);

  if (treeRules.length === 0) {
    lines.push("");
    lines.push("No tree visualizations matched.");
    return lines.join("\n");
  }

  for (const { rule, visuals } of treeRules) {
    lines.push("");
    lines.push(`## ${color.heading(rule.id)} [${severityLabel(rule.severity, color)}]`);
    if (rule.summary) lines.push(`Summary: ${rule.summary}`);
    for (const visual of visuals) {
      lines.push("");
      lines.push(`### ${visual.title ?? "Tree"}`);
      lines.push("");
      lines.push(...renderTreeDefinition(visual.definition, options, color));
    }
  }

  return lines.join("\n");
}

function renderTreeDefinition(definition: TreeDefinition, options: TreeRenderOptions, color: ReturnType<typeof colorFns>): string[] {
  const graph = normalizeTreeDefinition(definition);
  const lines: string[] = [];
  if (Object.keys(graph.paths).length > 0) lines.push(...renderPathTree(graph.paths, "", options, color));
  if (Object.keys(graph.nodes).length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(color.section("Named Nodes:"));
    for (const [name, patterns] of Object.entries(graph.nodes)) lines.push(`${bullet(options)} ${color.path(name)} ${color.dim(patterns.join(", "))}`);
  }
  if (graph.boundaries.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push(color.section("Boundaries:"));
    for (const boundary of graph.boundaries) lines.push(...renderBoundaryGraph(boundary, graph.nodes, options, color));
  }
  return lines.length > 0 ? lines : [color.dim("No tree paths, named nodes, or boundaries.")];
}

function renderPathTree(paths: TreePathDefinition, prefix: string, options: TreeRenderOptions, color: ReturnType<typeof colorFns>): string[] {
  const entries = Object.entries(paths);
  const lines: string[] = [];
  const glyphs = treeGlyphs(options.ascii);

  entries.forEach(([key, node], index) => {
    const last = index === entries.length - 1;
    lines.push(`${prefix}${last ? glyphs.last : glyphs.tee}${color.path(key)}`);
    const childPrefix = `${prefix}${last ? glyphs.space : glyphs.pipe}`;
    lines.push(...renderNodeDetails(node, childPrefix, options, color));
    if (node.children) lines.push(...renderPathTree(node.children, childPrefix, options, color));
  });

  return lines;
}

function renderNodeDetails(node: TreeNode, prefix: string, options: TreeRenderOptions, color: ReturnType<typeof colorFns>): string[] {
  const details = nodeDetailLines(node, color);
  if (details.length === 0) return [];
  const glyphs = boxGlyphs(options.ascii);
  return details.map((detail, index) => {
    const connector = details.length === 1 ? glyphs.last : index === 0 ? glyphs.top : index === details.length - 1 ? glyphs.last : glyphs.mid;
    return `${prefix}${connector}${detail}`;
  });
}

function nodeDetailLines(node: TreeNode, color: ReturnType<typeof colorFns>): string[] {
  const lines: string[] = [];
  if (node.docs && node.docs.length > 0) lines.push(`${color.key("docs")}: ${node.docs.join(", ")}`);
  if (node.files) {
    if (node.files.match) lines.push(`${color.key("files.match")}: ${joinList(node.files.match)}`);
    if (node.files.suffix) lines.push(`${color.key("files.suffix")}: ${joinList(node.files.suffix)}`);
    if (node.files.allowNames && node.files.allowNames.length > 0) lines.push(`${color.key("files.allowNames")}: ${node.files.allowNames.join(", ")}`);
  }
  if (node.folders?.denyNames && node.folders.denyNames.length > 0) lines.push(`${color.deny("folders.denyNames")}: ${node.folders.denyNames.join(", ")}`);
  if (node.imports) {
    if (node.imports.allow && node.imports.allow.length > 0) lines.push(`${color.allow("imports.allow")}: ${node.imports.allow.join(", ")}`);
    if (node.imports.deny && node.imports.deny.length > 0) lines.push(`${color.deny("imports.deny")}: ${node.imports.deny.join(", ")}`);
    if (node.imports.maxRelativeDepth !== undefined) lines.push(`${color.key("imports.maxRelativeDepth")}: ${node.imports.maxRelativeDepth}`);
  }
  return lines;
}

function renderBoundaryGraph(boundary: TreeBoundaryRule, nodes: Record<string, string[]>, options: TreeRenderOptions, color: ReturnType<typeof colorFns>): string[] {
  const fromValues = list(boundary.from);
  const relations = [
    ...list(boundary.allow).map((target) => ({ kind: "allow" as const, target })),
    ...list(boundary.deny).map((target) => ({ kind: "deny" as const, target })),
  ];

  return renderBoundaryItems(
    fromValues.map((from) => {
      const children: BoundaryGraphItem[] = [];
      for (const pattern of nodes[from] ?? (looksLikeNodeRef(from) ? [] : [from])) children.push({ label: color.dim(pattern) });
      for (const relation of relations) {
        const relationColor = relation.kind === "allow" ? color.allow : color.deny;
        children.push({
          label: relationColor(`${relation.kind} -> ${relation.target}`),
          children: (nodes[relation.target] ?? [relation.target]).map((pattern) => ({ label: color.dim(pattern) })),
        });
      }
      if (boundary.docs && boundary.docs.length > 0) {
        children.push({
          label: color.key("docs"),
          children: boundary.docs.map((doc) => ({ label: color.dim(doc) })),
        });
      }
      return { label: color.path(from), children };
    }),
    "",
    options,
  );
}

function renderBoundaryItems(items: BoundaryGraphItem[], prefix: string, options: TreeRenderOptions): string[] {
  const glyphs = treeGlyphs(options.ascii);
  const lines: string[] = [];

  items.forEach((item, index) => {
    const last = index === items.length - 1;
    lines.push(`${prefix}${last ? glyphs.last : glyphs.tee}${item.label}`);
    if (item.children && item.children.length > 0) {
      lines.push(...renderBoundaryItems(item.children, `${prefix}${last ? glyphs.space : glyphs.pipe}`, options));
    }
  });

  return lines;
}

function normalizeTreeDefinition(definition: TreeDefinition): { paths: TreePathDefinition; nodes: Record<string, string[]>; boundaries: TreeBoundaryRule[] } {
  if (isTreeGraphDefinition(definition)) {
    return {
      paths: definition.paths ?? {},
      nodes: Object.fromEntries(Object.entries(definition.nodes ?? {}).map(([name, patterns]) => [name, list(patterns)])),
      boundaries: definition.boundaries ?? [],
    };
  }
  return { paths: definition, nodes: {}, boundaries: [] };
}

function isTreeGraphDefinition(definition: TreeDefinition): definition is { paths?: TreePathDefinition; nodes?: Record<string, string | string[]>; boundaries?: TreeBoundaryRule[] } {
  return "paths" in definition || "nodes" in definition || "boundaries" in definition;
}

function treeGlyphs(ascii: boolean): { tee: string; last: string; pipe: string; space: string } {
  return ascii ? { tee: "|-- ", last: "`-- ", pipe: "|   ", space: "    " } : { tee: "├─ ", last: "└─ ", pipe: "│  ", space: "   " };
}

function boxGlyphs(ascii: boolean): { top: string; mid: string; last: string } {
  return ascii ? { top: "+-- ", mid: "|   ", last: "`-- " } : { top: "┌─ ", mid: "│  ", last: "└─ " };
}

function bullet(options: TreeRenderOptions): string {
  return options.ascii ? "-" : "•";
}

function joinList(value: string | string[]): string {
  return list(value).join(", ");
}

function list(value: string | string[] | undefined): string[] {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value];
}

function looksLikeNodeRef(value: string): boolean {
  return /^[A-Za-z][A-Za-z0-9_-]*$/.test(value);
}

function severityLabel(severity: Validator["severity"], color: ReturnType<typeof colorFns>): string {
  return severity === "error" ? color.error(severity) : color.warning(severity);
}

function colorFns(enabled: boolean) {
  const wrap = (code: string, value: string) => (enabled ? `\u001b[${code}m${value}\u001b[0m` : value);
  return {
    heading: (value: string) => wrap("1", value),
    section: (value: string) => wrap("1;36", value),
    path: (value: string) => wrap("36", value),
    key: (value: string) => wrap("33", value),
    allow: (value: string) => wrap("32", value),
    deny: (value: string) => wrap("31", value),
    error: (value: string) => wrap("31", value),
    warning: (value: string) => wrap("33", value),
    dim: (value: string) => wrap("2", value),
  };
}

function fixtureLabels(fixtures: RuleSummary["fixtures"]): string[] {
  return Object.entries(fixtures)
    .filter(([, present]) => present)
    .map(([label]) => label);
}

function printHelp(): void {
  console.log(`Usage:
  bun run opencanon rules
  bun run opencanon rules --validator <id>
  bun run opencanon rules --topic <topic>
  bun run opencanon rules --decision <id>
  bun run opencanon rules --tree
  bun run opencanon rules --tree --ascii
  bun run opencanon rules --format json

Options:
  --format markdown|json   Output format. Default: markdown.
  --topic <topic>          Show validators for a topic.
  --validator <id>         Show one validator.
  --decision <id>          Show validators linked to a decision.
  --tree                   Render tree visualizations.
  --ascii                  Use ASCII tree lines.
  --no-color               Disable ANSI colors.
`);
}
