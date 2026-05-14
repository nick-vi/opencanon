import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cac } from "cac";
import {
  CanonBundleSchema,
  CanonBundleOptionType,
  createPaths,
  fail,
  loadConfig,
  normalizeMarkdownHeading,
  relative,
  resolveInsideRoot,
  resolveRootDir,
  validateContext,
  writeAtomicJsonFileSync,
  writeAtomicTextFileSync,
  type CanonBundle,
  type CanonBundleOption,
  type CanonBundleOptionValue,
  type ContextConfig,
  type Decision,
  type ExternalTool,
  type ImpactSurface,
} from "@opencanon/core";
import { booleanOption, formatOption, rejectUnknownOptions } from "./options.ts";
import { loadValidators } from "./project.ts";

type InstallResult = {
  bundleId: string;
  description?: string;
  dryRun: boolean;
  options: BundleResolvedOptions;
  planPath?: string;
  files: InstallFileResult[];
  diagnostics: string[];
};

type BundleResolvedOptions = Record<string, CanonBundleOptionValue>;

type BundleInspectResult = {
  id: string;
  description?: string;
  topics: string[];
  validators: string[];
  options: Record<string, CanonBundleOption>;
  installables: {
    decisions: number;
    docs: string[];
    files: string[];
    impactSurfaces: number;
    externalTools: string[];
  };
};

type BundlePlanResult = BundleInspectResult & {
  resolvedOptions: BundleResolvedOptions;
  remote: boolean;
};

const BundleWriteAction = {
  Create: "create",
  Update: "update",
  Unchanged: "unchanged",
} as const;
type BundleWriteAction = (typeof BundleWriteAction)[keyof typeof BundleWriteAction];

type InstallFileResult = { path: string; action: BundleWriteAction };

const BundleCliOption = {
  DryRun: "dryRun",
  Format: "format",
  H: "h",
  Help: "help",
  Option: "option",
  Out: "out",
  Plan: "plan",
  Sha256: "sha256",
} as const;

const BundleCliFlag = {
  Sha256: "--sha256",
  Sha256Value: "--sha256 <hash>",
} as const;

const BundleCliDescription = {
  Sha256: "Expected SHA-256 for remote JSON bundles.",
} as const;

const EmptyValue = "<none>";

export async function runBundleCommand(args = Bun.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const [command = "help", ...rest] = args;
  if (command === "inspect") {
    await runBundleInspectCommand(rest, cwd);
    return;
  }
  if (command === "plan") {
    await runBundlePlanCommand(rest, cwd);
    return;
  }
  if (command === "install") {
    await runBundleInstallCommand(rest, cwd);
    return;
  }
  if (command === "-h" || command === "--help" || command === "help") {
    printBundleHelp();
    return;
  }
  fail(`Unknown bundle command: ${command}`);
}

async function runBundleInspectCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon bundle inspect");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option(BundleCliFlag.Sha256Value, BundleCliDescription.Sha256);

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [BundleCliOption.Help, BundleCliOption.H, BundleCliOption.Format, BundleCliOption.Sha256]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printBundleHelp();
    return;
  }

  const bundleRef = parsed.args[0] ? String(parsed.args[0]) : "";
  if (!bundleRef) fail("Missing bundle id or path.");
  const rootDir = resolveRootDir(cwd);
  const bundle = await loadBundle(rootDir, bundleRef, { sha256: stringOption(options.sha256, BundleCliFlag.Sha256) });
  const result = inspectBundle(bundle);
  if (formatOption(options.format) === "json") console.log(JSON.stringify(result, null, 2));
  else console.log(renderInspectResult(result));
}

async function runBundlePlanCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon bundle plan");
  cli.option("-h, --help", "Show help.");
  cli.option("--format <format>", "Output format.");
  cli.option("--option <key=value>", "Set a typed bundle option. Repeatable.");
  cli.option("--out <path>", "Write the rendered markdown plan to a project-relative path.");
  cli.option(BundleCliFlag.Sha256Value, BundleCliDescription.Sha256);

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [BundleCliOption.Help, BundleCliOption.H, BundleCliOption.Format, BundleCliOption.Option, BundleCliOption.Out, BundleCliOption.Sha256]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printBundleHelp();
    return;
  }

  const bundleRef = parsed.args[0] ? String(parsed.args[0]) : "";
  if (!bundleRef) fail("Missing bundle id or path.");
  const rootDir = resolveRootDir(cwd);
  const bundle = await loadBundle(rootDir, bundleRef, { sha256: stringOption(options.sha256, BundleCliFlag.Sha256) });
  validateBundleInstallTargets(bundle);
  const resolvedOptions = resolveBundleOptions(bundle, optionValues(options.option));
  const materialized = materializeBundle(bundle, resolvedOptions);
  validateBundleInstallTargets(materialized);
  const result: BundlePlanResult = {
    ...inspectBundle(materialized),
    options: bundle.options,
    resolvedOptions,
    remote: isRemoteBundleRef(bundleRef),
  };
  const markdown = renderPlanResult(result);
  const outPath = stringOption(options.out, "--out");
  if (outPath) {
    const target = resolveBundleWritePath(rootDir, outPath);
    mkdirSync(path.dirname(target.absolutePath), { recursive: true });
    writeAtomicTextFileSync(target.absolutePath, `${markdown}\n`);
  }

  const format = formatOption(options.format);
  if (format === "json") console.log(JSON.stringify({ ...result, outPath: outPath ? resolveBundleWritePath(rootDir, outPath).path : undefined }, null, 2));
  else console.log(markdown);
}

async function runBundleInstallCommand(args: string[], cwd: string): Promise<void> {
  const cli = cac("opencanon bundle install");
  cli.option("-h, --help", "Show help.");
  cli.option("--dry-run", "Show files that would change without writing.");
  cli.option("--format <format>", "Output format.");
  cli.option("--option <key=value>", "Set a typed bundle option. Repeatable.");
  cli.option("--plan <path>", "Require a previously reviewed bundle plan file.");
  cli.option(BundleCliFlag.Sha256Value, BundleCliDescription.Sha256);

  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [
    BundleCliOption.Help,
    BundleCliOption.H,
    BundleCliOption.DryRun,
    BundleCliOption.Format,
    BundleCliOption.Option,
    BundleCliOption.Plan,
    BundleCliOption.Sha256,
  ]);
  if (booleanOption(options.help) || booleanOption(options.h)) {
    printBundleHelp();
    return;
  }

  const bundlePath = parsed.args[0] ? String(parsed.args[0]) : "";
  if (!bundlePath) fail("Missing bundle path.");
  const format = formatOption(options.format);
  const rootDir = resolveRootDir(cwd);
  const result = await installBundle(rootDir, bundlePath, {
    dryRun: booleanOption(options.dryRun),
    optionValues: optionValues(options.option),
    planPath: stringOption(options.plan, "--plan"),
    sha256: stringOption(options.sha256, BundleCliFlag.Sha256),
  });

  if (format === "json") console.log(JSON.stringify(result, null, 2));
  else console.log(renderInstallResult(result));
  process.exit(result.diagnostics.length === 0 ? 0 : 1);
}

async function installBundle(
  rootDir: string,
  bundlePath: string,
  options: { dryRun: boolean; optionValues: string[]; planPath?: string; sha256?: string },
): Promise<InstallResult> {
  const paths = createPaths(rootDir);
  const loadedBundle = await loadBundle(rootDir, bundlePath, { sha256: options.sha256 });
  validateBundleInstallTargets(loadedBundle);
  const resolvedOptions = resolveBundleOptions(loadedBundle, options.optionValues);
  const bundle = materializeBundle(loadedBundle, resolvedOptions);
  validateBundleInstallTargets(bundle);
  const files: InstallResult["files"] = [];
  const diagnostics: string[] = [];
  const planPath = options.planPath ? resolveBundleWritePath(rootDir, options.planPath).path : undefined;
  if (planPath && !existsSync(path.join(rootDir, planPath))) fail(`Bundle plan does not exist: ${planPath}`);

  files.push(writeJsonArray(rootDir, relative(rootDir, paths.decisionsPath), bundle.decisions, mergeDecisions, options.dryRun));
  files.push(...bundle.docs.map((doc) => writeMarkdownDoc(rootDir, doc.path, doc.heading, doc.body, options.dryRun)));
  files.push(writeJsonArray(rootDir, relative(rootDir, paths.impactSurfacesPath), bundle.impactSurfaces, mergeImpactSurfaces, options.dryRun));
  files.push(...bundle.files.map((file) => writeBundleFile(rootDir, file.path, file.content, options.dryRun)));

  if (Object.keys(bundle.externalTools).length > 0) {
    files.push(writeConfigExternalTools(rootDir, bundle.externalTools, options.dryRun));
  }

  if (!options.dryRun) {
    const validators = await loadValidators(rootDir, createPaths(rootDir));
    const decisions = JSON.parse(readFileSync(paths.decisionsPath, "utf8")) as Decision[];
    const surfaces = existsSync(paths.impactSurfacesPath) ? (JSON.parse(readFileSync(paths.impactSurfacesPath, "utf8")) as ImpactSurface[]) : [];
    diagnostics.push(...validateContext({ decisions, validators, impactSurfaces: surfaces, paths: createPaths(rootDir) }));
  }

  return {
    bundleId: bundle.id,
    description: bundle.description,
    dryRun: options.dryRun,
    options: resolvedOptions,
    planPath,
    files,
    diagnostics,
  };
}

async function loadBundle(rootDir: string, bundlePath: string, options: { sha256?: string } = {}): Promise<CanonBundle> {
  if (isRemoteBundleRef(bundlePath)) return loadRemoteBundle(bundlePath, options);
  const absolute = path.isAbsolute(bundlePath) ? bundlePath : path.resolve(rootDir, bundlePath);
  if (path.extname(absolute) === ".json") return loadLocalJsonBundle(absolute);
  const module = await import(`${pathToFileURL(absolute).href}?mtime=${Date.now()}`);
  return CanonBundleSchema.parse(module.default ?? module.bundle ?? module);
}

function loadLocalJsonBundle(bundlePath: string): CanonBundle {
  return CanonBundleSchema.parse(JSON.parse(readFileSync(bundlePath, "utf8")));
}

async function loadRemoteBundle(bundleUrl: string, options: { sha256?: string }): Promise<CanonBundle> {
  const parsedUrl = new URL(bundleUrl);
  if (parsedUrl.protocol !== "https:" && !(parsedUrl.protocol === "http:" && isLoopbackHost(parsedUrl.hostname))) {
    fail("Remote bundles must use HTTPS.");
  }
  if (!parsedUrl.pathname.endsWith(".json")) fail("Remote bundles must be JSON data files. Remote TypeScript bundles are not executed.");
  if (!options.sha256) fail("Remote bundles require --sha256.");

  const response = await fetch(parsedUrl);
  if (!response.ok) fail(`Failed to fetch remote bundle: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash("sha256").update(bytes).digest("hex");
  if (actualSha256 !== options.sha256.toLowerCase()) fail(`Remote bundle SHA-256 mismatch. Expected ${options.sha256}, got ${actualSha256}.`);

  let payload: unknown;
  try {
    payload = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("Remote bundle is not valid JSON.");
  }
  return CanonBundleSchema.parse(payload);
}

function isRemoteBundleRef(value: string): boolean {
  try {
    const parsedUrl = new URL(value);
    return parsedUrl.protocol === "https:" || parsedUrl.protocol === "http:";
  } catch {
    return false;
  }
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

function writeJsonArray<T extends { id: string }>(
  rootDir: string,
  filePath: string,
  incoming: T[],
  merge: (current: T[], incoming: T[]) => T[],
  dryRun: boolean,
): InstallFileResult {
  const target = resolveBundleWritePath(rootDir, filePath);
  const absolute = target.absolutePath;
  const current = existsSync(absolute) ? (JSON.parse(readFileSync(absolute, "utf8")) as T[]) : [];
  const next = merge(current, incoming);
  const action = !existsSync(absolute) ? BundleWriteAction.Create : JSON.stringify(current) === JSON.stringify(next) ? BundleWriteAction.Unchanged : BundleWriteAction.Update;
  if (!dryRun && action !== BundleWriteAction.Unchanged) {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeAtomicJsonFileSync(absolute, next);
  }
  return { path: target.path, action };
}

function mergeDecisions(current: Decision[], incoming: Decision[]): Decision[] {
  return mergeById(current, incoming, (existing, item) => ({
    ...existing,
    ...item,
    topics: uniqueStrings([...(existing.topics ?? []), ...(item.topics ?? [])]),
    applies: uniqueStrings([...(existing.applies ?? []), ...(item.applies ?? [])]),
    validatorIds: uniqueStrings([...(existing.validatorIds ?? []), ...(item.validatorIds ?? [])]),
    docs: uniqueStrings([...(existing.docs ?? []), ...(item.docs ?? [])]),
  }));
}

function mergeImpactSurfaces(current: ImpactSurface[], incoming: ImpactSurface[]): ImpactSurface[] {
  return mergeById(current, incoming, (existing, item) => ({
    ...existing,
    ...item,
    applies: uniqueStrings([...(existing.applies ?? []), ...(item.applies ?? [])]),
    owns: uniqueStrings([...(existing.owns ?? []), ...(item.owns ?? [])]),
    dependsOn: uniqueStrings([...(existing.dependsOn ?? []), ...(item.dependsOn ?? [])]),
    downstream: uniqueStrings([...(existing.downstream ?? []), ...(item.downstream ?? [])]),
    risks: uniqueStrings([...(existing.risks ?? []), ...(item.risks ?? [])]),
    docs: uniqueStrings([...(existing.docs ?? []), ...(item.docs ?? [])]),
    decisionIds: uniqueStrings([...(existing.decisionIds ?? []), ...(item.decisionIds ?? [])]),
  }));
}

function mergeById<T extends { id: string }>(current: T[], incoming: T[], merge: (existing: T, item: T) => T): T[] {
  const byId = new Map(current.map((item) => [item.id, item]));
  for (const item of incoming) {
    const existing = byId.get(item.id);
    byId.set(item.id, existing ? merge(existing, item) : item);
  }
  return [...byId.values()];
}

function writeMarkdownDoc(rootDir: string, filePath: string, heading: string, body: string, dryRun: boolean): InstallFileResult {
  const target = resolveBundleWritePath(rootDir, filePath);
  const absolute = target.absolutePath;
  const headingLine = `## ${heading}`;
  const slug = normalizeMarkdownHeading(heading);
  const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : `# ${titleFromPath(target.path)}\n`;
  const hasHeading = new RegExp(`^#{1,6}\\s+${escapeRegex(heading)}\\s*$`, "m").test(current) || current.includes(`#${slug}`);
  const next = hasHeading ? current : `${current.trimEnd()}\n\n${headingLine}\n\n${body.trim()}\n`;
  const action = !existsSync(absolute) ? BundleWriteAction.Create : current === next ? BundleWriteAction.Unchanged : BundleWriteAction.Update;
  if (!dryRun && action !== BundleWriteAction.Unchanged) {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, next);
  }
  return { path: target.path, action };
}

function writeBundleFile(rootDir: string, filePath: string, content: string, dryRun: boolean): InstallFileResult {
  const target = resolveBundleWritePath(rootDir, filePath);
  const absolute = target.absolutePath;
  const current = existsSync(absolute) ? readFileSync(absolute, "utf8") : undefined;
  const action = current === undefined ? BundleWriteAction.Create : current === content ? BundleWriteAction.Unchanged : BundleWriteAction.Update;
  if (!dryRun && action !== BundleWriteAction.Unchanged) {
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, content);
  }
  return { path: target.path, action };
}

function writeConfigExternalTools(rootDir: string, externalTools: Record<string, ExternalTool>, dryRun: boolean): InstallFileResult {
  const configPath = path.join(rootDir, "opencanon.config.json");
  const { configPath: loadedPath } = loadConfig(rootDir);
  const current = existsSync(configPath) ? (JSON.parse(readFileSync(configPath, "utf8")) as ContextConfig) : {};
  const next = {
    ...current,
    externalTools: {
      ...(current.externalTools ?? {}),
      ...externalTools,
    },
  };
  const action = !loadedPath ? BundleWriteAction.Create : JSON.stringify(current) === JSON.stringify(next) ? BundleWriteAction.Unchanged : BundleWriteAction.Update;
  if (!dryRun && action !== BundleWriteAction.Unchanged) writeAtomicJsonFileSync(configPath, next);
  return { path: "opencanon.config.json", action };
}

function renderInstallResult(result: InstallResult): string {
  return [
    "# OpenCanon Bundle Install",
    "",
    `Bundle: ${result.bundleId}`,
    ...(result.description ? [`Description: ${result.description}`] : []),
    `Dry run: ${result.dryRun ? "yes" : "no"}`,
    ...(Object.keys(result.options).length > 0 ? ["", "Options:", ...Object.entries(result.options).map(([key, value]) => `- ${key}: ${formatBundleOptionValue(value)}`)] : []),
    ...(result.planPath ? ["", `Plan: ${result.planPath}`] : []),
    "",
    ...result.files.map((file) => `- ${file.action} ${file.path}`),
    ...(result.diagnostics.length > 0 ? ["", "Diagnostics:", ...result.diagnostics.map((diagnostic) => `- ${diagnostic}`)] : []),
  ].join("\n");
}

function inspectBundle(bundle: CanonBundle): BundleInspectResult {
  return {
    id: bundle.id,
    description: bundle.description,
    topics: bundle.topics,
    validators: bundle.validators,
    options: bundle.options,
    installables: {
      decisions: bundle.decisions.length,
      docs: bundle.docs.map((doc) => `${doc.path}#${normalizeMarkdownHeading(doc.heading)}`),
      files: bundle.files.map((file) => file.path),
      impactSurfaces: bundle.impactSurfaces.length,
      externalTools: Object.keys(bundle.externalTools),
    },
  };
}

function renderInspectResult(result: BundleInspectResult): string {
  return [
    "# OpenCanon Bundle",
    "",
    `ID: ${result.id}`,
    ...(result.description ? [`Description: ${result.description}`] : []),
    `Topics: ${result.topics.join(", ")}`,
    `Validators: ${result.validators.length > 0 ? result.validators.join(", ") : EmptyValue}`,
    "",
    "Options:",
    ...renderOptionDefinitions(result.options),
    "",
    "Installables:",
    `- decisions: ${result.installables.decisions}`,
    `- docs: ${result.installables.docs.length > 0 ? result.installables.docs.join(", ") : EmptyValue}`,
    `- files: ${result.installables.files.length > 0 ? result.installables.files.join(", ") : EmptyValue}`,
    `- impact surfaces: ${result.installables.impactSurfaces}`,
    `- external tools: ${result.installables.externalTools.length > 0 ? result.installables.externalTools.join(", ") : EmptyValue}`,
  ].join("\n");
}

function renderPlanResult(result: BundlePlanResult): string {
  return [
    "# OpenCanon Bundle Plan",
    "",
    `Bundle: ${result.id}`,
    ...(result.description ? [`Description: ${result.description}`] : []),
    ...(result.remote ? ["Source: remote JSON bundle. Review the resolved install preview and pinned hash before installing."] : []),
    "",
    "Resolved Options:",
    ...Object.entries(result.resolvedOptions).map(([key, value]) => `- ${key}: ${formatBundleOptionValue(value)}`),
    "",
    "Install Preview:",
    `- decisions: ${result.installables.decisions}`,
    `- docs: ${result.installables.docs.length > 0 ? result.installables.docs.join(", ") : EmptyValue}`,
    `- files: ${result.installables.files.length > 0 ? result.installables.files.join(", ") : EmptyValue}`,
    `- impact surfaces: ${result.installables.impactSurfaces}`,
    `- external tools: ${result.installables.externalTools.length > 0 ? result.installables.externalTools.join(", ") : EmptyValue}`,
  ].join("\n");
}

function renderOptionDefinitions(options: Record<string, CanonBundleOption>): string[] {
  const entries = Object.entries(options);
  if (entries.length === 0) return [`- ${EmptyValue}`];
  return entries.map(([key, option]) => {
    const parts = [
      option.type,
      option.required ? "required" : undefined,
      option.default !== undefined ? `default: ${formatBundleOptionValue(option.default)}` : undefined,
      option.values && option.values.length > 0 ? `values: ${option.values.join(", ")}` : undefined,
      option.description,
    ].filter(Boolean);
    return `- ${key} (${parts.join("; ")})`;
  });
}

function resolveBundleOptions(bundle: CanonBundle, rawValues: string[]): BundleResolvedOptions {
  const parsed = parseOptionAssignments(rawValues);
  const resolved: BundleResolvedOptions = {};
  for (const [key, definition] of Object.entries(bundle.options)) {
    const values = parsed.get(key);
    if (values && values.length > 0) resolved[key] = coerceBundleOption(key, definition, values);
    else if (definition.default !== undefined) resolved[key] = definition.default;
    else if (definition.required) fail(`Missing required bundle option: ${key}`);
  }
  for (const key of parsed.keys()) {
    if (!bundle.options[key]) fail(`Unknown bundle option: ${key}`);
  }
  return resolved;
}

function parseOptionAssignments(rawValues: string[]): Map<string, string[]> {
  const valuesByKey = new Map<string, string[]>();
  for (const rawValue of rawValues) {
    const separatorIndex = rawValue.indexOf("=");
    if (separatorIndex <= 0) fail(`Bundle option must use key=value: ${rawValue}`);
    const key = rawValue.slice(0, separatorIndex).trim();
    const value = rawValue.slice(separatorIndex + 1);
    if (!key) fail(`Bundle option must use key=value: ${rawValue}`);
    const values = valuesByKey.get(key) ?? [];
    values.push(value);
    valuesByKey.set(key, values);
  }
  return valuesByKey;
}

function coerceBundleOption(key: string, definition: CanonBundleOption, values: string[]): CanonBundleOptionValue {
  const value = values.at(-1) ?? "";
  if (definition.type === CanonBundleOptionType.String) return value;
  if (definition.type === CanonBundleOptionType.StringArray) return values.flatMap((item) => item.split(",").map((part) => part.trim()).filter(Boolean));
  if (definition.type === CanonBundleOptionType.Boolean) {
    if (["true", "1", "yes", "on"].includes(value)) return true;
    if (["false", "0", "no", "off"].includes(value)) return false;
    fail(`Bundle option ${key} must be a boolean.`);
  }
  if (definition.type === CanonBundleOptionType.Number) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) fail(`Bundle option ${key} must be a number.`);
    return numberValue;
  }
  if (definition.type === CanonBundleOptionType.Enum) {
    if (!definition.values || definition.values.length === 0) fail(`Bundle option ${key} is enum but has no values.`);
    if (!definition.values.includes(value)) fail(`Bundle option ${key} must be one of: ${definition.values.join(", ")}`);
    return value;
  }
  fail(`Unsupported bundle option type for ${key}.`);
}

function materializeBundle(bundle: CanonBundle, options: BundleResolvedOptions): CanonBundle {
  return CanonBundleSchema.parse({
    ...bundle,
    decisions: interpolateValue(bundle.decisions, options),
    docs: interpolateValue(bundle.docs, options),
    files: interpolateValue(bundle.files, options),
    impactSurfaces: interpolateValue(bundle.impactSurfaces, options),
    externalTools: interpolateValue(bundle.externalTools, options),
  });
}

function validateBundleInstallTargets(bundle: CanonBundle): void {
  for (const file of bundle.files) assertSafeBundleOwnedFilePath(file.path);
}

function assertSafeBundleOwnedFilePath(filePath: string): void {
  const normalized = filePath.replace(/\\/g, "/");
  const segments = normalized.split("/").filter(Boolean);
  const blockedSegments = new Set([".git", ".opencanon", "node_modules"]);
  if (segments.some((segment) => blockedSegments.has(segment))) fail(`Bundle file target is not allowed: ${filePath}`);

  const basename = segments.at(-1) ?? "";
  const blockedBasenames = new Set(["package.json", "bun.lock", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "deno.lock"]);
  if (blockedBasenames.has(basename)) fail(`Bundle file target is not allowed: ${filePath}`);
}

function interpolateValue(value: unknown, options: BundleResolvedOptions): unknown {
  if (typeof value === "string") return interpolateString(value, options);
  if (Array.isArray(value)) return value.map((item) => interpolateValue(item, options));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, nestedValue]) => [key, interpolateValue(nestedValue, options)]));
  }
  return value;
}

function interpolateString(value: string, options: BundleResolvedOptions): string {
  return value.replace(/\{\{([a-zA-Z][a-zA-Z0-9_-]*)\}\}/g, (match, key: string) => {
    if (!(key in options)) return match;
    return formatBundleOptionValue(options[key]);
  });
}

function optionValues(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  if (values.some((item) => typeof item !== "string" || item.length === 0)) fail("--option requires key=value.");
  return values as string[];
}

function stringOption(value: unknown, flag: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.length === 0) fail(`${flag} requires a value.`);
  return value;
}

function formatBundleOptionValue(value: CanonBundleOptionValue): string {
  return Array.isArray(value) ? value.join(", ") : String(value);
}

function printBundleHelp(): void {
  console.log(`Usage:
  bun run opencanon bundle inspect <bundle.ts|bundle.json>
  bun run opencanon bundle plan <bundle.ts|bundle.json> [--option key=value]
  bun run opencanon bundle install <bundle.ts|bundle.json> [--option key=value]
  bun run opencanon bundle install https://example.com/bundle.json --sha256 <hash>

Commands:
  inspect  Show bundle metadata, options, and installable assets.
  plan     Render a deterministic install plan.
  install  Install or update docs, decisions, impact surfaces, config, and files from a canon bundle.
`);
}

function titleFromPath(filePath: string): string {
  return path.basename(filePath, path.extname(filePath)).replace(/[-_]/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)].filter(Boolean);
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function resolveBundleWritePath(rootDir: string, filePath: string): { path: string; absolutePath: string } {
  const resolved = resolveInsideRoot(rootDir, filePath);
  if (!resolved.ok) fail(`Unsafe bundle path ${filePath}: ${resolved.message}`);
  return resolved;
}
