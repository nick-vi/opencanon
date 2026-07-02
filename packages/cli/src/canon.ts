import { mkdirSync } from "node:fs";
import path from "node:path";
import { cac } from "cac";
import { buildDefinitionGraph, createPaths, fail, Format, loadConventionGraph, loadImpactSurfaces, relative, resolveRootDir, splitList, validateImpactSurfaces, writeAtomicJsonFileSync } from "@opencanon/core";
import type { ImpactSurface } from "@opencanon/core";
import { runAreasCommand } from "./areas.ts";
import { runChangesCommand } from "./changes.ts";
import { runConventionsCommand } from "./conventions.ts";
import { runSpecsCommand } from "./specs.ts";
import { loadProjectContext } from "./project.ts";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";

const CanonDefinitionKind = {
  Conventions: "conventions",
  Areas: "areas",
  Specs: "specs",
  Changes: "changes",
} as const;

type CanonDefinitionKind = (typeof CanonDefinitionKind)[keyof typeof CanonDefinitionKind];

const canonicalKinds = new Map<string, CanonDefinitionKind>([
  ["convention", CanonDefinitionKind.Conventions],
  ["conventions", CanonDefinitionKind.Conventions],
  ["area", CanonDefinitionKind.Areas],
  ["areas", CanonDefinitionKind.Areas],
  ["spec", CanonDefinitionKind.Specs],
  ["specs", CanonDefinitionKind.Specs],
  ["change", CanonDefinitionKind.Changes],
  ["changes", CanonDefinitionKind.Changes],
]);

export async function runCanonCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "list", ...rest] = args;
  if (command === "list") {
    await runCanonListCommand(rest, cwd);
    return;
  }
  if (command === "render") {
    await runCanonRenderCommand(rest, cwd);
    return;
  }
  if (command === "draft") {
    if (rest[0] === "impact-surface" || rest[0] === "impact-surfaces" || rest[0] === "surface" || rest[0] === "surfaces") {
      await runImpactSurfaceDraftCommand(rest.slice(1), cwd);
      return;
    }
    await runCanonKindCommand(command, rest, cwd);
    return;
  }
  if (command === "history" || command === "diff" || command === "related-commits" || command === "versions" || command === "impact-evolution") {
    await runCanonKindCommand(command, rest, cwd);
    return;
  }
  if (command === "map") {
    await runCanonMapCommand(rest, cwd);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printCanonHelp();
    return;
  }
  fail(`Unknown canon command: ${command}`);
}

async function runCanonListCommand(args: string[], cwd: string): Promise<void> {
  const [maybeKind, ...rest] = args;
  if (maybeKind === "-h" || maybeKind === "--help" || maybeKind === "help") {
    printCanonHelp();
    return;
  }
  const kind = maybeKind ? canonicalKind(maybeKind) : undefined;
  if (kind) {
    await runKindCommand(kind, ["list", ...rest], cwd);
    return;
  }
  const cli = cac("opencanon canon list");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printCanonHelp();
    return;
  }
  if (parsed.args.length > 0) fail(`Unknown canon definition kind: ${String(parsed.args[0])}`);

  const project = await loadProjectContext(resolveRootDir(cwd));
  if (formatOption(options.format) === Format.Json) {
    console.log(
      JSON.stringify(
        {
          conventions: project.conventions.map(definitionListItem),
          areas: project.areas.map(definitionListItem),
          specs: project.specs.map(definitionListItem),
          changes: project.changes.map(definitionListItem),
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("# Project Canon");
  console.log("");
  printDefinitionGroup("Conventions", project.conventions.map((item) => `${item.id} - ${item.title}`));
  printDefinitionGroup("Areas", project.areas.map((item) => `${item.id} - ${item.title}`));
  printDefinitionGroup("Specs", project.specs.map((item) => `${item.id} - ${item.title}`));
  printDefinitionGroup("Changes", project.changes.map((item) => `${item.id} - ${item.title}`));
}

async function runCanonRenderCommand(args: string[], cwd: string): Promise<void> {
  const [maybeKind, ...rest] = args;
  if (maybeKind === "-h" || maybeKind === "--help" || maybeKind === "help") {
    printCanonHelp();
    return;
  }
  const kind = maybeKind ? canonicalKind(maybeKind) : undefined;
  if (kind) {
    await runKindCommand(kind, ["render", ...rest], cwd);
    return;
  }
  if (maybeKind && maybeKind.startsWith("-")) fail("opencanon canon render requires a definition kind when render options are provided.");
  if (maybeKind) fail(`Unknown canon definition kind: ${maybeKind}`);
  for (const definitionKind of Object.values(CanonDefinitionKind)) await runKindCommand(definitionKind, ["render"], cwd);
}

async function runCanonKindCommand(command: string, args: string[], cwd: string): Promise<void> {
  const [kindArg, ...rest] = args;
  if (!kindArg) fail(`opencanon canon ${command} requires a definition kind.`);
  const kind = canonicalKind(kindArg);
  if (!kind) fail(`Unknown canon definition kind: ${kindArg}`);
  if (command === "impact-evolution" && kind !== CanonDefinitionKind.Conventions) fail("opencanon canon impact-evolution only supports convention impact surfaces.");
  await runKindCommand(kind, [command, ...rest], cwd);
}

async function runCanonMapCommand(args: string[], cwd: string): Promise<void> {
  const format = formatFromArgs("opencanon canon map", args);
  const project = await loadProjectContext(resolveRootDir(cwd));
  const graph = buildDefinitionGraph({
    areas: project.areas,
    specs: project.specs,
    changes: project.changes,
    conventions: project.conventions,
    impactSurfaces: project.impactSurfaces,
    validators: project.validators.map((validator) => ({ id: validator.id, conventionIds: validator.conventionIds })),
  });
  if (format === Format.Json) {
    console.log(JSON.stringify(graph, null, 2));
    return;
  }
  console.log("# Project Canon Map");
  console.log("");
  console.log(`Nodes: ${graph.nodes.length}`);
  console.log(`Edges: ${graph.edges.length}`);
  console.log(`Diagnostics: ${graph.diagnostics.length}`);
  if (graph.diagnostics.length > 0) {
    console.log("");
    console.log("Diagnostics:");
    for (const diagnostic of graph.diagnostics) console.log(`- ${diagnostic.severity} [${diagnostic.code}]: ${diagnostic.message}`);
  }
  console.log("");
  console.log("Edges:");
  for (const edge of graph.edges.slice(0, 100)) console.log(`- ${edge.from} -> ${edge.to} (${edge.kind}${edge.label ? `: ${edge.label}` : ""})`);
  if (graph.edges.length > 100) console.log(`- ... ${graph.edges.length - 100} more`);
}

async function runImpactSurfaceDraftCommand(args: string[], cwd: string): Promise<void> {
  const commandName = "opencanon canon draft impact-surface";
  const cli = cac(commandName);
  cli.option("-h, --help", "Show help.");
  cli.option("--title <title>", "Human-readable impact surface title.");
  cli.option("--applies <globs>", "Comma-separated or repeated file globs governed by this surface.");
  cli.option("--owns <targets>", "Comma-separated or repeated ownership targets.");
  cli.option("--depends-on <surfaceIds>", "Comma-separated or repeated upstream impact surface ids.");
  cli.option("--downstream <surfaceIds>", "Comma-separated or repeated downstream impact surface ids.");
  cli.option("--risk <risk>", "Comma-separated or repeated risk statements.");
  cli.option("--docs <refs>", "Comma-separated or repeated docs references.");
  cli.option("--convention <ids>", "Comma-separated or repeated convention ids.");
  cli.option("--enforced", "Create an enforced surface. Requires docs and convention links.");
  cli.option("--format <format>", "Output format.");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, ["help", "h", "title", "applies", "owns", "dependsOn", "downstream", "risk", "docs", "convention", "enforced", "format"]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printImpactSurfaceDraftHelp();
    return;
  }
  if (parsed.args.length !== 1) fail(`${commandName} requires exactly one impact surface id.`);

  const rootDir = resolveRootDir(cwd);
  const paths = createPaths(rootDir);
  const existing = loadImpactSurfaces(paths);
  if (existing.diagnostics.length > 0) fail(existing.diagnostics.join("\n"));
  const conventionGraph = await loadConventionGraph(rootDir, paths, paths.conventionsPath);
  const id = String(parsed.args[0]);
  if (existing.surfaces.some((surface) => surface.id === id)) fail(`Impact surface already exists: ${id}`);

  const title = stringValues(options.title)[0];
  if (!title) fail("--title is required.");
  const applies = listOption(options.applies);
  if (applies.length === 0) fail("--applies is required.");
  const surface: ImpactSurface = {
    id,
    title,
    applies,
    proposed: !booleanOption(options.enforced),
  };
  const owns = listOption(options.owns);
  const dependsOn = listOption(options.dependsOn);
  const downstream = listOption(options.downstream);
  const risks = listOption(options.risk);
  const docs = listOption(options.docs);
  const conventionIds = listOption(options.convention);
  if (owns.length > 0) surface.owns = owns;
  if (dependsOn.length > 0) surface.dependsOn = dependsOn;
  if (downstream.length > 0) surface.downstream = downstream;
  if (risks.length > 0) surface.risks = risks;
  if (docs.length > 0) surface.docs = docs;
  if (conventionIds.length > 0) surface.conventionIds = conventionIds;

  const next = [...existing.surfaces, surface];
  const diagnostics = validateImpactSurfaces(next, paths, new Set(conventionGraph.conventions.byId.keys()));
  if (diagnostics.length > 0) fail(diagnostics.join("\n"));
  mkdirSync(path.dirname(paths.impactSurfacesPath), { recursive: true });
  writeAtomicJsonFileSync(paths.impactSurfacesPath, next);

  const output = {
    id: surface.id,
    path: relative(rootDir, paths.impactSurfacesPath),
    surface,
  };
  if (formatOption(options.format) === Format.Json) {
    console.log(JSON.stringify(output, null, 2));
    return;
  }
  console.log("# Impact Surface Draft");
  console.log("");
  console.log(`ID: ${output.id}`);
  console.log(`Path: ${output.path}`);
  console.log(`Applies: ${surface.applies.join(", ")}`);
  console.log(`State: ${surface.proposed ? "proposed" : "enforced"}`);
}

function listOption(value: unknown): string[] {
  return stringValues(value).flatMap((item) => splitList(item));
}

function definitionListItem(definition: { id: string; title: string }): { id: string; title: string } {
  return { id: definition.id, title: definition.title };
}

function canonicalKind(value: string): CanonDefinitionKind | undefined {
  return canonicalKinds.get(value);
}

async function runKindCommand(kind: CanonDefinitionKind, args: string[], cwd: string): Promise<void> {
  if (kind === CanonDefinitionKind.Conventions) {
    await runConventionsCommand(args, cwd);
    return;
  }
  if (kind === CanonDefinitionKind.Areas) {
    await runAreasCommand(args, cwd);
    return;
  }
  if (kind === CanonDefinitionKind.Specs) {
    await runSpecsCommand(args, cwd);
    return;
  }
  await runChangesCommand(args, cwd, {
    allowDefinitionCommands: true,
    listCommandName: "opencanon canon list changes",
  });
}

function printDefinitionGroup(title: string, items: string[]): void {
  console.log(`## ${title}`);
  console.log("");
  if (items.length === 0) {
    console.log("- none");
  } else {
    for (const item of items) console.log(`- ${item}`);
  }
  console.log("");
}

function formatFromArgs(command: string, args: string[]): Format {
  let format: Format = Format.Markdown;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      printCanonHelp();
      process.exit(0);
    }
    if (arg === "--format") {
      const value = args[index + 1];
      if (value !== Format.Markdown && value !== Format.Json) fail(`Invalid --format: ${value}`);
      format = value;
      index += 1;
      continue;
    }
    fail(`Unknown ${command} option: ${arg}`);
  }
  return format;
}

function printCanonHelp(): void {
  console.log(`Usage:
  opencanon canon list
  opencanon canon list <conventions|areas|specs|changes>
  opencanon canon render <conventions|areas|specs|changes>
  opencanon canon draft <convention|area|spec|change> <id> [options]
  opencanon canon draft impact-surface <id> --title <title> --applies <globs>
  opencanon canon history <convention|area|spec|change> <id>
  opencanon canon diff <convention|area|spec|change> <id> [--from <ref>] [--to <ref>]
  opencanon canon related-commits <convention|area|spec|change> <id>
  opencanon canon versions <convention|area|spec|change> <id>
  opencanon canon impact-evolution convention <surface-id>
  opencanon canon map [--format markdown|json]

Commands:
  list             List Project Canon definitions.
  render           Render OpenCanon-owned definition artifacts.
  draft            Draft a definition source file.
  history          Show definition history.
  diff             Show definition diff between Git refs.
  related-commits  Show commits touching definition source files.
  versions         Show historical definition versions.
  impact-evolution Show commits affecting an impact surface's convention links.
  map              Show the definition relationship graph.
`);
}

function printImpactSurfaceDraftHelp(): void {
  console.log(`Usage:
  opencanon canon draft impact-surface <id> --title <title> --applies <globs>

Options:
  --title <title>        Required title.
  --applies <globs>      Required comma-separated or repeated file globs.
  --owns <targets>       Optional comma-separated or repeated ownership targets.
  --depends-on <ids>     Optional comma-separated or repeated upstream surface ids.
  --downstream <ids>     Optional comma-separated or repeated downstream surface ids.
  --risk <risk>          Optional comma-separated or repeated risk statements.
  --docs <refs>          Optional comma-separated or repeated docs references.
  --convention <ids>     Optional comma-separated or repeated convention ids.
  --enforced             Require docs and convention links immediately.
  --format markdown|json Output format. Default: markdown.
`);
}
