import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { cac } from "cac";
import { createDefaultConfig, fail, HookInstallHost, resolveRootDir, splitList } from "@opencanon/core";
import { installHook } from "@opencanon/core";
import type { HookInstallResult } from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions, stringValues } from "./options.ts";
import type { Format } from "@opencanon/core";

const OpenCanonInitFile = {
  Decisions: "decisions.json",
  Architecture: "canon/architecture.md",
  Lifecycle: "canon/lifecycle.md",
  Testing: "canon/testing.md",
  Impact: "canon/impact.md",
  Security: "canon/security.md",
  ImpactSurfaces: "impact-surfaces.json",
  ProposedImpactNotes: "proposed-impact-notes.json",
} as const;

type OpenCanonInitFile = (typeof OpenCanonInitFile)[keyof typeof OpenCanonInitFile];

const InitFileAction = {
  Create: "create",
  Update: "update",
  Unchanged: "unchanged",
  Skip: "skip",
} as const;

type InitFileAction = (typeof InitFileAction)[keyof typeof InitFileAction];

const EmptyFileContent = "";
const OpenCanonCommandName = "opencanon";
const Utf8Encoding = "utf8";
const generatedGitignoreEntries = [
  ".opencanon/daemon.json",
  ".opencanon/daemon.log",
  ".opencanon/setup.json",
  ".opencanon/*.sqlite",
  ".opencanon/*.sqlite-shm",
  ".opencanon/*.sqlite-wal",
];

export type InitQuery = {
  nonInteractive: boolean;
  dryRun: boolean;
  force: boolean;
  missingOnly: boolean;
  format: Format;
  hooks: HookInstallHost[];
  docsDir: string;
  validatorsPath: string;
  fixturesDir: string;
  cacheDir: string;
  fileDiscovery: "git" | "filesystem";
};

type InitFileResult = {
  path: string;
  action: InitFileAction;
};

export type InitResult = {
  rootDir: string;
  dryRun: boolean;
  files: InitFileResult[];
  hooks: HookInstallResult[];
  diagnostics: string[];
  nextSteps: string[];
};

export async function runInitCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const rootDir = resolveRootDir(cwd);
  const query = await parseInitArgs(args, rootDir);
  const result = runInit(rootDir, query);

  if (query.format === "json") console.log(JSON.stringify(result, null, 2));
  else console.log(renderInitMarkdown(result));
  process.exit(result.diagnostics.length === 0 ? 0 : 1);
}

async function parseInitArgs(args: string[], rootDir: string): Promise<InitQuery> {
  const cli = cac("opencanon init");
  cli.option("-h, --help", "Show help.");
  cli.option("--non-interactive", "Use defaults without prompting.");
  cli.option("--yes", "Alias for --non-interactive.");
  cli.option("--dry-run", "Show files that would change without writing.");
  cli.option("--force", "Overwrite existing OpenCanon scaffold files.");
  cli.option("--format <format>", "Output format.");
  cli.option("--hooks <hosts>", "Install feedback hooks: codex, claude, opencode, all, or none.");
  cli.option("--docs-dir <path>", "Context docs directory.");
  cli.option("--validators-path <path>", "Validator entrypoint path.");
  cli.option("--fixtures-dir <path>", "Validator fixtures directory.");
  cli.option("--cache-dir <path>", "Generated cache directory.");
  cli.option("--file-discovery <mode>", "Project discovery mode: git or filesystem.");

  const parsed = cli.parse(["node", OpenCanonCommandName, ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [
    "help",
    "h",
    "yes",
    "nonInteractive",
    "dryRun",
    "force",
    "format",
    "hooks",
    "docsDir",
    "validatorsPath",
    "fixturesDir",
    "cacheDir",
    "fileDiscovery",
  ]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    printInitHelp();
    process.exit(0);
  }
  if (parsed.args.length > 0) fail(`Unexpected init arguments: ${parsed.args.join(", ")}`);

  const defaults = defaultInitQuery(rootDir);
  const query: InitQuery = {
    nonInteractive: booleanOption(options.nonInteractive) || booleanOption(options.yes),
    dryRun: booleanOption(options.dryRun),
    force: booleanOption(options.force),
    missingOnly: false,
    format: formatOption(options.format),
    hooks: hooksOption(options.hooks),
    docsDir: stringOption(options.docsDir, defaults.docsDir),
    validatorsPath: stringOption(options.validatorsPath, defaults.validatorsPath),
    fixturesDir: stringOption(options.fixturesDir, defaults.fixturesDir),
    cacheDir: stringOption(options.cacheDir, defaults.cacheDir),
    fileDiscovery: fileDiscoveryOption(options.fileDiscovery, defaults.fileDiscovery),
  };

  if (query.nonInteractive) return query;
  if (!process.stdin.isTTY || !process.stdout.isTTY) fail("opencanon init is interactive by default. Use --non-interactive or --yes.");
  return promptInitQuery(query);
}

async function promptInitQuery(defaults: InitQuery): Promise<InitQuery> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return {
      ...defaults,
      nonInteractive: true,
      docsDir: await promptString(rl, "Docs directory", defaults.docsDir),
      validatorsPath: await promptString(rl, "Validators path", defaults.validatorsPath),
      fixturesDir: await promptString(rl, "Fixtures directory", defaults.fixturesDir),
      cacheDir: await promptString(rl, "Cache directory", defaults.cacheDir),
      fileDiscovery: fileDiscoveryOption(await promptString(rl, "File discovery (git/filesystem)", defaults.fileDiscovery), defaults.fileDiscovery),
      hooks: hooksOption(await promptString(rl, "Feedback hooks (none/codex/claude/opencode/all)", defaults.hooks.join(",") || "none")),
    };
  } finally {
    rl.close();
  }
}

async function promptString(rl: ReturnType<typeof createInterface>, label: string, fallback: string): Promise<string> {
  const value = (await rl.question(`${label} [${fallback}]: `, {})).trim();
  return value || fallback;
}

export function runInit(rootDir: string, query: InitQuery): InitResult {
  const diagnostics: string[] = [];
  const files: InitFileResult[] = [];
  const config = initConfigOverrides(rootDir, query);

  if (Object.keys(config).length > 0) {
    files.push(writeManagedFile(rootDir, "opencanon.config.json", `${JSON.stringify(config, null, 2)}\n`, query, diagnostics));
  }
  files.push(writeManagedFile(rootDir, docsPath(query.docsDir, OpenCanonInitFile.Decisions), "[]\n", query, diagnostics));
  files.push(writeManagedFile(rootDir, docsPath(query.docsDir, OpenCanonInitFile.Architecture), canonDocTemplate("Architecture"), query, diagnostics));
  files.push(writeManagedFile(rootDir, docsPath(query.docsDir, OpenCanonInitFile.Lifecycle), canonDocTemplate("Lifecycle"), query, diagnostics));
  files.push(writeManagedFile(rootDir, docsPath(query.docsDir, OpenCanonInitFile.Testing), canonDocTemplate("Testing"), query, diagnostics));
  files.push(writeManagedFile(rootDir, docsPath(query.docsDir, OpenCanonInitFile.Impact), canonDocTemplate("Impact"), query, diagnostics));
  files.push(writeManagedFile(rootDir, docsPath(query.docsDir, OpenCanonInitFile.Security), canonDocTemplate("Security"), query, diagnostics));
  files.push(writeManagedFile(rootDir, docsPath(query.docsDir, OpenCanonInitFile.ImpactSurfaces), "[]\n", query, diagnostics));
  files.push(writeManagedFile(rootDir, docsPath(query.docsDir, OpenCanonInitFile.ProposedImpactNotes), "[]\n", query, diagnostics));
  files.push(writeManagedFile(rootDir, query.validatorsPath, validatorsTemplate(), query, diagnostics));
  files.push(writeManagedFile(rootDir, path.join(query.fixturesDir, ".gitkeep"), EmptyFileContent, query, diagnostics));
  files.push(writeManagedFile(rootDir, ".agents/skills/opencanon/SKILL.md", skillTemplate(), query, diagnostics));
  files.push(writeManagedFile(rootDir, ".agents/skills/opencanon/.gitignore", "runtime/\n", query, diagnostics));
  files.push(writeManagedFile(rootDir, ".agents/skills/opencanon/index.ts", skillBarrelTemplate(), query, diagnostics));
  files.push(writeManagedFile(rootDir, ".agents/skills/opencanon/scripts/opencanon.ts", cliScriptTemplate(), query, diagnostics, 0o755));
  files.push(writeManagedFile(rootDir, ".agents/skills/opencanon/scripts/opencode-plugin.ts", opencodePluginTemplate(), query, diagnostics));
  files.push(...copyBundledRuntimeFiles(rootDir, query, diagnostics));
  files.push(writeGitignoreEntries(rootDir, [`${query.cacheDir.replace(/\/$/, "")}/`, ...generatedGitignoreEntries], query));
  files.push(writePackageScript(rootDir, query, diagnostics));

  const hooks = query.hooks.map((host) =>
    installHook({
      rootDir,
      host,
      scope: "project",
      dryRun: query.dryRun,
    }),
  );
  diagnostics.push(...hooks.flatMap((hook) => hook.diagnostics));

  return {
    rootDir,
    dryRun: query.dryRun,
    files,
    hooks,
    diagnostics,
    nextSteps: nextSteps(query),
  };
}

function initConfigOverrides(rootDir: string, query: InitQuery): Record<string, unknown> {
  const defaults = createDefaultConfig(rootDir);
  const config: Record<string, unknown> = {};
  if (query.docsDir !== defaults.docsDir) {
    config.docsDir = query.docsDir;
    config.decisionsPath = docsPath(query.docsDir, OpenCanonInitFile.Decisions);
    config.impactSurfacesPath = docsPath(query.docsDir, OpenCanonInitFile.ImpactSurfaces);
    config.proposedImpactNotesPath = docsPath(query.docsDir, OpenCanonInitFile.ProposedImpactNotes);
  }
  if (query.validatorsPath !== defaults.validatorsPath) config.validatorsPath = query.validatorsPath;
  if (query.fixturesDir !== defaults.fixturesDir) config.fixturesDir = query.fixturesDir;
  if (query.cacheDir !== defaults.cacheDir) config.cacheDir = query.cacheDir;
  if (query.fileDiscovery !== defaults.fileDiscovery) config.fileDiscovery = query.fileDiscovery;
  return config;
}

function defaultInitQuery(rootDir: string): Omit<InitQuery, "nonInteractive" | "dryRun" | "force" | "format" | "hooks"> {
  const defaults = createDefaultConfig(rootDir);
  return {
    missingOnly: false,
    docsDir: defaults.docsDir,
    validatorsPath: defaults.validatorsPath,
    fixturesDir: defaults.fixturesDir,
    cacheDir: defaults.cacheDir,
    fileDiscovery: defaults.fileDiscovery,
  };
}

function docsPath(docsDir: string, file: OpenCanonInitFile): string {
  return path.join(docsDir, file);
}

function writeManagedFile(
  rootDir: string,
  relativePath: string,
  content: string,
  query: Pick<InitQuery, "dryRun" | "force" | "missingOnly">,
  diagnostics: string[],
  mode?: number,
): InitFileResult {
  const filePath = path.join(rootDir, relativePath);
  const exists = existsSync(filePath);
  const current = exists ? readFileSync(filePath, Utf8Encoding) : EmptyFileContent;
  if (exists && current === content) return { path: relativePath, action: InitFileAction.Unchanged };
  if (exists && query.missingOnly) return { path: relativePath, action: InitFileAction.Skip };
  if (exists && !query.force) {
    diagnostics.push(`${relativePath} already exists; use --force to overwrite it.`);
    return { path: relativePath, action: InitFileAction.Skip };
  }
  if (!query.dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, mode === undefined ? undefined : { mode });
  }
  return { path: relativePath, action: exists ? InitFileAction.Update : InitFileAction.Create };
}

function copyManagedFile(
  rootDir: string,
  sourcePath: string,
  relativePath: string,
  query: Pick<InitQuery, "dryRun" | "force" | "missingOnly">,
  diagnostics: string[],
): InitFileResult {
  const filePath = path.join(rootDir, relativePath);
  const content = readFileSync(sourcePath);
  const exists = existsSync(filePath);
  const current = exists ? readFileSync(filePath) : Buffer.alloc(0);
  if (exists && current.equals(content)) return { path: relativePath, action: InitFileAction.Unchanged };
  if (exists && query.missingOnly) return { path: relativePath, action: InitFileAction.Skip };
  if (exists && !query.force) {
    diagnostics.push(`${relativePath} already exists; use --force to overwrite it.`);
    return { path: relativePath, action: InitFileAction.Skip };
  }
  if (!query.dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content, { mode: statSync(sourcePath).mode & 0o777 });
  }
  return { path: relativePath, action: exists ? InitFileAction.Update : InitFileAction.Create };
}

function copyBundledRuntimeFiles(rootDir: string, query: InitQuery, diagnostics: string[]): InitFileResult[] {
  const sourceSkillRoot = currentSkillRoot();
  if (!sourceSkillRoot) {
    diagnostics.push("Could not locate the running OpenCanon skill root; bundled runtime was not copied.");
    return [];
  }

  const runtimeDir = path.join(sourceSkillRoot, "runtime");
  if (!existsSync(runtimeDir)) {
    diagnostics.push(`Bundled OpenCanon runtime is missing from ${sourceSkillRoot}; run bun run build:skill.`);
    return [];
  }

  return listRuntimeFiles(runtimeDir).map((sourcePath) =>
    copyManagedFile(rootDir, sourcePath, toSlash(path.join(".agents/skills/opencanon/runtime", path.relative(runtimeDir, sourcePath))), query, diagnostics),
  );
}

function currentSkillRoot(): string | null {
  if (process.env.OPENCANON_SKILL_ROOT) return path.resolve(process.env.OPENCANON_SKILL_ROOT);
  const entry = typeof Bun === "undefined" ? process.argv[1] : Bun.argv[1];
  if (!entry) return null;
  const scriptsDir = path.dirname(path.resolve(entry));
  const skillRoot = path.dirname(scriptsDir);
  return path.basename(scriptsDir) === "scripts" && path.basename(skillRoot) === OpenCanonCommandName ? skillRoot : null;
}

function listRuntimeFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) return listRuntimeFiles(file);
      if (entry.isFile()) return [file];
      return [];
    })
    .sort((left, right) => left.localeCompare(right));
}

function toSlash(file: string): string {
  return file.split(path.sep).join("/");
}

function writeGitignoreEntries(rootDir: string, entries: string[], query: Pick<InitQuery, "dryRun">): InitFileResult {
  const relativePath = ".gitignore";
  const filePath = path.join(rootDir, relativePath);
  const exists = existsSync(filePath);
  const current = exists ? readFileSync(filePath, Utf8Encoding) : EmptyFileContent;
  const lines = current.split(/\r?\n/).map((line) => line.trim());
  const missingEntries = entries.filter((entry) => !lines.includes(entry));
  if (missingEntries.length === 0) return { path: relativePath, action: InitFileAction.Unchanged };

  if (!query.dryRun) {
    const prefix = current.length > 0 && !current.endsWith("\n") ? "\n" : "";
    writeFileSync(filePath, `${current}${prefix}${missingEntries.join("\n")}\n`);
  }
  return { path: relativePath, action: exists ? InitFileAction.Update : InitFileAction.Create };
}

function writePackageScript(rootDir: string, query: InitQuery, diagnostics: string[]): InitFileResult {
  const relativePath = "package.json";
  const filePath = path.join(rootDir, relativePath);
  const script = packageScript();

  if (!existsSync(filePath)) {
    const content = `${JSON.stringify({ type: "module", scripts: { opencanon: script } }, null, 2)}\n`;
    if (!query.dryRun) writeFileSync(filePath, content);
    return { path: relativePath, action: InitFileAction.Create };
  }

  let packageJson: Record<string, any>;
  try {
    packageJson = JSON.parse(readFileSync(filePath, Utf8Encoding)) as Record<string, any>;
  } catch (error) {
    diagnostics.push(`Could not parse package.json: ${error instanceof Error ? error.message : String(error)}`);
    return { path: relativePath, action: InitFileAction.Skip };
  }

  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {};
  if (scripts.opencanon === script) return { path: relativePath, action: InitFileAction.Unchanged };
  if (scripts.opencanon && query.missingOnly) return { path: relativePath, action: InitFileAction.Skip };
  if (scripts.opencanon && !query.force) {
    diagnostics.push(`package.json already has scripts.opencanon; use --force to replace it.`);
    return { path: relativePath, action: InitFileAction.Skip };
  }

  const next = {
    ...packageJson,
    scripts: {
      ...scripts,
      opencanon: script,
    },
  };
  if (!query.dryRun) writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`);
  return { path: relativePath, action: InitFileAction.Update };
}

function packageScript(): string {
  return `bun .agents/skills/${OpenCanonCommandName}/scripts/${OpenCanonCommandName}.ts`;
}

function nextSteps(query: InitQuery): string[] {
  const steps = [
    "Fill docs/opencanon/decisions.json and referenced Markdown docs from the repository's existing conventions.",
    "Add mechanically checkable validators in the configured validators path.",
    "Add valid and invalid fixtures under fixtures/<validator-id>/ for each validator.",
    "Run bun run opencanon context --check.",
    "Run bun run opencanon validate --check-fixtures.",
    "Run bun run opencanon doctor.",
  ];
  if (query.hooks.length === 0) steps.push("Install feedback hooks with bun run opencanon hook install --all --dry-run.");
  return steps;
}

export function renderInitMarkdown(result: InitResult): string {
  const lines: string[] = [];
  lines.push("# OpenCanon Init");
  lines.push("");
  lines.push(`Root: ${result.rootDir}${result.dryRun ? " (dry-run)" : ""}`);
  lines.push("");
  lines.push("Files:");
  for (const file of result.files) lines.push(`- [${file.action}] ${file.path}`);
  for (const hook of result.hooks) {
    lines.push(`- [hook:${hook.host}] ${hook.scope}${hook.dryRun ? " (dry-run)" : ""}`);
    for (const file of hook.files) lines.push(`  - [${file.action}] ${file.path}`);
  }
  if (result.diagnostics.length > 0) {
    lines.push("");
    lines.push("Diagnostics:");
    for (const diagnostic of result.diagnostics) lines.push(`- ${diagnostic}`);
  }
  lines.push("");
  lines.push("Next Steps:");
  for (const step of result.nextSteps) lines.push(`- ${step}`);
  return lines.join("\n");
}

function printInitHelp(): void {
  console.log(`Usage:
  bun run opencanon init
  bun run opencanon init --non-interactive
  bun run opencanon init --non-interactive --hooks codex,claude,opencode
  bun run opencanon init --non-interactive --dry-run

Options:
  --non-interactive           Use defaults without prompting.
  --yes                       Alias for --non-interactive.
  --dry-run                   Show files that would change without writing.
  --force                     Overwrite existing scaffold files.
  --format markdown|json      Output format. Default: markdown.
  --hooks <hosts>             codex, claude, opencode, all, or none. Default: none.
  --docs-dir <path>           Default: docs/opencanon.
  --validators-path <path>    Default: .agents/skills/opencanon/validators/index.ts.
  --fixtures-dir <path>       Default: .agents/skills/opencanon/fixtures.
  --cache-dir <path>          Default: .opencanon/cache.
  --file-discovery <mode>     git or filesystem. Default: git inside Git repos, otherwise filesystem.
`);
}

function canonDocTemplate(title: string): string {
  return `# ${title}

Add human-readable canon docs here. Link decisions and validators to headings with normalized anchors:

## Example Policy

Write the current policy here, then reference it from decisions.json with an explicit docs ref.
`;
}

function validatorsTemplate(): string {
  return `export default [];
`;
}

function cliScriptTemplate(): string {
  return `#!/usr/bin/env bun
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const skillRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const runtimeCli = "runtime/cli.js";

const cli = await import(pathToFileURL(path.join(skillRoot, runtimeCli)).href);
if (typeof cli.runOpenCanonCli !== "function") {
  throw new Error(\`OpenCanon runtime \${runtimeCli} does not export runOpenCanonCli().\`);
}

await cli.runOpenCanonCli(Bun.argv.slice(2));
`;
}

function skillBarrelTemplate(): string {
  return `export * from "./runtime/core.js";
export {
  annotationRequiresTags,
  duplicateBoundaryLiterals,
  externalCommand,
  externalDiagnostics,
  fileNames,
  folderStructure,
  migrationReferences,
  noBareExcept,
  noBarrelCrossBoundary,
  noBypassComments,
  noCommentMatches,
  noDeepRelativeImports,
  noFolderNames,
  noForbiddenCalls,
  noForbiddenImports,
  noHeaderComments,
  noHardcodedConfigValues,
  noImports,
  noLayerCall,
  noNativeEnums,
  noSecretLikeLiterals,
  noShimFiles,
  noUnusedExports,
  repeatedLiterals,
  requireExportPattern,
  requiredFileSibling,
  requiredFunctionParam,
  restrictedSymbols,
  sensitiveChangePolicy,
  similarFunctionNames,
} from "./runtime/validators.js";
`;
}

function opencodePluginTemplate(): string {
  return `export { OpenCanonPlugin } from "../runtime/cli.js";
`;
}

function skillTemplate(): string {
  return `---
name: opencanon
description: Use when modifying repository code and needing local conventions, pattern decisions, style consistency, architecture rules, or OpenCanon context scoped by topic or file path.
---

# OpenCanon

Before editing repository code, load only the relevant convention context.

## First-Run Setup

If OpenCanon is not initialized in the current repository, run:

\`\`\`bash
bun run opencanon setup --yes
\`\`\`

Use \`--hooks codex\`, \`--hooks claude\`, or \`--hooks opencode\` when the current host is known. Setup scaffolds missing files, installs requested feedback hooks, validates context, runs doctor, runs project validation, starts the daemon, and writes generated setup state under \`.opencanon/setup.json\`.

## Workflow

1. Run \`bun run opencanon context --files <paths...>\` when intended files are known.
2. Run \`bun run opencanon context --changed\` for worktree edits.
3. Run \`bun run opencanon context --topic <topic>\` when only the area is known.
4. Use \`bun run opencanon rules --validator <id>\` or \`bun run opencanon rules --topic <topic>\` for a quick map of validator summaries, scopes, decisions, and fixtures. Use \`bun run opencanon rules --tree --validator <id>\` for tree-backed validators.
5. Treat returned context as the current source of truth.
6. Do not add internal shims, aliases, compatibility wrappers, deprecated paths, or parallel APIs.
7. After edits, run \`bun run opencanon validate --files <paths...>\`.
8. Use \`bun run opencanon bundle install <bundle.ts|bundle.json> --option key=value\` for explicit installable canon bundles.
9. Use \`bun run opencanon baseline check\` or \`bun run opencanon baseline update\` when working with known existing findings.
10. Any finding must be addressed before the agent completes the task. Fix valid findings, fix bugged validators with fixtures, or ask the user before changing a decision.

## Validator Authoring

Validators live at the configured validators path. Export a validator definition or an array. Import authoring APIs from the skill barrel, usually \`../index.ts\` from the default \`.agents/skills/opencanon/validators/index.ts\` path. The barrel exposes \`defineValidator\`, \`createValidatorFactory\`, runtime types, and curated factories such as \`fileNames\` and \`noImports\`.

Each real validator should have:

- a kebab-case \`id\`
- \`topics\`
- \`severity: "error" | "warning"\`
- \`scope: "file" | "folder" | "import-edge" | "package" | "project"\`
- optional \`facts\` declaring consumed parsed facts: \`imports\`, \`exports\`, \`symbols\`, \`calls\`, \`literals\`, \`comments\`, \`references\`, \`annotations\`, \`diagnostics\`, or \`duplicates\`
- optional \`summary\` as a string or synchronous definition-time callback for \`opencanon rules\`
- optional \`applies\` globs
- \`validate({ ctx, runtime })\`
- valid and invalid fixtures under \`fixtures/<validator-id>/valid\` and \`fixtures/<validator-id>/invalid\`
- optional fixed fixtures under \`fixtures/<validator-id>/fixed\` when structured fixes are provided

Prefer \`ctx.facts.*\` for imports, exports, symbols, calls, literals, comments, references, annotations, diagnostics, and duplicates. Use \`ctx.graph.*\` for graph-shaped symbols, references, callers, callees, and impact. Use \`ctx.impact.*\` for configured impact surfaces and proposed impact notes, and \`ctx.baseline.*\` for known findings.

While editing one validator, run:

\`\`\`bash
bun run opencanon validate --check-fixtures --validator <validator-id>
\`\`\`

Before finishing, run:

\`\`\`bash
bun run opencanon context --check
bun run opencanon validate --check-fixtures
bun run opencanon validate --changed
bun run opencanon daemon check
bun run opencanon doctor
\`\`\`
`;
}

function hooksOption(value: unknown): HookInstallHost[] {
  const values = stringValues(value).flatMap(splitList);
  if (values.length === 0 || values.includes("none")) return [];
  if (values.includes("all")) return [HookInstallHost.Codex, HookInstallHost.Claude, HookInstallHost.OpenCode];
  return values.map((item) => {
    if (item === HookInstallHost.Codex || item === HookInstallHost.Claude || item === HookInstallHost.OpenCode) return item;
    fail(`Unsupported --hooks value: ${item}`);
  });
}

function fileDiscoveryOption(value: unknown, fallback: InitQuery["fileDiscovery"]): InitQuery["fileDiscovery"] {
  if (value === undefined) return fallback;
  if (value === "git" || value === "filesystem") return value;
  fail(`Unsupported --file-discovery: ${String(value)}`);
}

function stringOption(value: unknown, fallback: string): string {
  if (value === undefined) return fallback;
  if (typeof value === "string" && value.length > 0) return value;
  fail("Option requires a string value.");
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
