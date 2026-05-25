import { existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { writeAtomicTextFileSync } from "./atomic.ts";
import type { ContextPaths } from "./context.ts";
import { listFiles, normalizePath, relative } from "./core.ts";
import { loadProjectFiles } from "./project-files.ts";
import { buildWorkspaceGraph } from "./workspace.ts";
import type { WorkspacePackage } from "./validator-types.ts";

/** Repo-relative path for the generated `@opencanon/project` authoring module. */
export const ProjectTypesFilePath = ".agents/skills/opencanon/generated/project.ts";
/** Repo-relative path for generated ambient module declarations used by fixture authoring. */
export const ProjectAliasesFilePath = ".agents/skills/opencanon/generated/aliases.d.ts";
/** Result returned after writing the generated `@opencanon/project` module. */
export type ProjectTypesGenerationResult = {
  /** Repo-relative path to the generated module. */
  path: string;
  /** Number of workspace packages exported through `Packages` and `PackageRoots`. */
  packageCount: number;
  /** Number of package/dependency import strings exported through `ImportSpecifiers`. */
  importSpecifierCount: number;
  /** Number of npm dependency records exported through `Npm`. */
  npmDependencyCount: number;
  /** Number of Rust crates exported through `Crates` and `CrateRoots`. */
  crateCount: number;
  /** Number of Cargo dependency records exported through `Cargo`. */
  cargoDependencyCount: number;
  /** Number of Python dependency records exported through `Python`. */
  pythonDependencyCount: number;
  /** Number of ambient module declarations generated for fixture and validator authoring. */
  aliasModuleCount: number;
};

type GeneratedEntry = {
  key: string;
  value: unknown;
  docs: string[];
};

type PackageLike = {
  name: string;
  description?: string;
  version?: string;
  installedVersion?: string;
  section?: string;
  source?: string;
};

type CargoManifest = {
  name?: string;
  description?: string;
  version?: string;
  root: string;
  manifestPath: string;
  dependencies: CargoDependency[];
};

type CargoDependency = {
  name: string;
  section: string;
  manifestPath: string;
  version?: string;
};

type PythonDependency = {
  name: string;
  source: string;
  group: string;
  version?: string;
};

type AmbientModuleDeclaration = {
  source: string;
  namedExports: string[];
  defaultExport: boolean;
  namespaceExport: boolean;
};

/**
 * Generate the gitignored `@opencanon/project` authoring module.
 *
 * The generated module exports const objects with SCREAMING_SNAKE_CASE keys:
 * `Packages`, `PackageRoots`, `ImportSpecifiers`, `Npm`, `Crates`, `CrateRoots`, `Cargo`, and `Python`.
 */
export function generateProjectTypes(rootDir: string, paths: ContextPaths): ProjectTypesGenerationResult {
  const sourceFiles = listFiles(
    rootDir,
    (file) => {
      const filePath = normalizePath(relative(rootDir, file));
      return filePath === "package.json" || filePath.endsWith("/package.json");
    },
    (directory) => isSkippedProjectTypesDirectory(relative(rootDir, directory)),
  )
    .map((file) => relative(rootDir, file))
    .filter(isProjectTypesIndexInput);
  const files = loadProjectFiles(rootDir, sourceFiles, { id: "project-types", severity: "warning" }, paths);
  const workspace = buildWorkspaceGraph(rootDir, files, () => []);
  const packages = workspace.packages;
  const packageEntries = uniqueEntries(packages.map(packageEntry));
  const packageRootEntries = uniqueEntries(packages.map(packageRootEntry));
  const npmDependencyEntries = npmDependencyEntriesForPackages(rootDir, packages);
  const npmDependencyEntriesForOutput = uniqueEntriesByValue(npmDependencyEntries.map(npmDependencyEntry));
  const importSpecifierEntries = uniqueEntriesByValue([...packages.map(packageImportEntry), ...npmDependencyEntries.map(npmDependencyImportEntry)]);
  const crates = readCargoManifests(rootDir);
  const crateEntries = uniqueEntries(crates.map(crateEntry));
  const crateRootEntries = uniqueEntries(crates.map(crateRootEntry));
  const cargoDependencyEntries = crates.flatMap(cargoDependencyEntriesForManifest);
  const cargoDependencyEntriesForOutput = uniqueEntriesByValue(cargoDependencyEntries.map(cargoDependencyEntry));
  const pythonDependencyEntries = readPythonDependencies(rootDir);
  const pythonDependencyEntriesForOutput = uniqueEntriesByValue(pythonDependencyEntries.map(pythonDependencyEntry));
  const ambientModules = buildAmbientModuleDeclarations(rootDir, paths.fixturesDir, packages);
  const source = renderProjectTypes({
    packages: packageEntries,
    packageRoots: packageRootEntries,
    importSpecifiers: importSpecifierEntries,
    npmDependencies: npmDependencyEntriesForOutput,
    crates: crateEntries,
    crateRoots: crateRootEntries,
    cargoDependencies: cargoDependencyEntriesForOutput,
    pythonDependencies: pythonDependencyEntriesForOutput,
  });
  const aliasesSource = renderAmbientAliases(ambientModules);
  const outputPath = path.join(rootDir, ProjectTypesFilePath);
  const aliasesOutputPath = path.join(rootDir, ProjectAliasesFilePath);
  mkdirSync(path.dirname(outputPath), { recursive: true });
  writeTextFileIfChanged(outputPath, source);
  writeTextFileIfChanged(aliasesOutputPath, aliasesSource);
  return {
    path: ProjectTypesFilePath,
    packageCount: packageEntries.length,
    importSpecifierCount: importSpecifierEntries.length,
    npmDependencyCount: npmDependencyEntriesForOutput.length,
    crateCount: crateEntries.length,
    cargoDependencyCount: cargoDependencyEntriesForOutput.length,
    pythonDependencyCount: pythonDependencyEntriesForOutput.length,
    aliasModuleCount: ambientModules.length,
  };
}

function writeTextFileIfChanged(filePath: string, content: string): void {
  if (existsSync(filePath) && readFileSync(filePath, "utf8") === content) return;
  writeAtomicTextFileSync(filePath, content);
}

function isProjectTypesIndexInput(filePath: string): boolean {
  const normalized = normalizePath(filePath);
  return !normalized.startsWith(".agents/skills/opencanon/generated/");
}

function isSkippedProjectTypesDirectory(directory: string): boolean {
  const normalized = normalizePath(directory);
  return normalized === "node_modules" || normalized.includes("/node_modules/") || normalized === ".git" || normalized.includes("/.git/");
}

function packageEntry(item: WorkspacePackage): GeneratedEntry {
  return {
    key: packageKey(item),
    value: item.name,
    docs: packageDocs(item),
  };
}

function packageRootEntry(item: WorkspacePackage): GeneratedEntry {
  return {
    key: packageKey(item),
    value: item.root,
    docs: packageDocs(item),
  };
}

function packageImportEntry(item: WorkspacePackage): GeneratedEntry {
  return {
    key: packageKey(item),
    value: item.name,
    docs: packageDocs(item),
  };
}

function npmDependencyEntriesForPackages(rootDir: string, packages: WorkspacePackage[]): PackageLike[] {
  const packageJsonByName = new Map<string, PackageLike>();
  for (const item of packages) {
    for (const [dependencyName, version] of Object.entries(item.dependencies)) {
      if (packageJsonByName.has(dependencyName)) continue;
      const packageJson = readDependencyPackageJson(rootDir, dependencyName);
      packageJsonByName.set(dependencyName, { ...packageJson, version, section: "package dependency" });
    }
  }
  return [...packageJsonByName.values()].sort((left, right) => left.name.localeCompare(right.name));
}

function readDependencyPackageJson(rootDir: string, dependencyName: string): PackageLike {
  const dependencyPackagePath = path.join(rootDir, "node_modules", dependencyName, "package.json");
  try {
    const parsed = JSON.parse(readFileSync(dependencyPackagePath, "utf8")) as unknown;
    if (isRecord(parsed)) {
      return {
        name: stringValue(parsed.name) ?? dependencyName,
        description: stringValue(parsed.description),
        installedVersion: stringValue(parsed.version),
        source: `node_modules/${dependencyName}/package.json`,
      };
    }
  } catch {
    // Dependency package metadata is optional; declared dependency names are still useful constants.
  }
  return { name: dependencyName };
}

function packageKey(item: WorkspacePackage): string {
  if (item.kind === "root" && item.name === "<root>") return "ROOT";
  return screamingSnakeKey(item.name === "<root>" ? "root" : item.name);
}

function screamingSnakeKey(input: string): string {
  const withoutScope = input.replace(/^@/, "");
  const normalized = withoutScope
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
  return normalized || "ROOT";
}

function packageDocs(item: WorkspacePackage): string[] {
  const description = stringValue(item.packageJson.description);
  return [
    ...(description ? [description] : []),
    `Package: ${item.name}`,
    `Root: ${item.root || "."}`,
    `Kind: ${item.kind}`,
    ...(booleanValue(item.packageJson.private) !== undefined ? [`Private: ${String(booleanValue(item.packageJson.private))}`] : []),
    `Source: ${normalizePath(path.posix.join(item.root, "package.json"))}`,
  ];
}

function importDocs(item: PackageLike): string[] {
  return [
    ...(item.description ? [item.description] : []),
    `Import specifier: ${item.name}`,
    ...(item.version ? [`Version: ${item.version}`] : []),
    ...(item.source ? [`Source: ${item.source}`] : []),
  ];
}

function npmDependencyEntry(item: PackageLike): GeneratedEntry {
  return {
    key: screamingSnakeKey(item.name),
    value: {
      name: item.name,
      version: item.version ?? "",
      ...(item.installedVersion ? { installedVersion: item.installedVersion } : {}),
    },
    docs: npmDependencyDocs(item),
  };
}

function npmDependencyImportEntry(item: PackageLike): GeneratedEntry {
  return {
    key: screamingSnakeKey(item.name),
    value: item.name,
    docs: npmDependencyDocs(item),
  };
}

function npmDependencyDocs(item: PackageLike): string[] {
  return [
    ...(item.description ? [item.description] : []),
    `npm dependency: ${item.name}`,
    ...(item.version ? [`Declared version: ${item.version}`] : []),
    ...(item.installedVersion ? [`Installed version: ${item.installedVersion}`] : []),
    ...(item.source ? [`Source: ${item.source}`] : []),
  ];
}

function crateEntry(item: CargoManifest): GeneratedEntry {
  return {
    key: screamingSnakeKey(item.name ?? item.root),
    value: item.name ?? item.root,
    docs: crateDocs(item),
  };
}

function crateRootEntry(item: CargoManifest): GeneratedEntry {
  return {
    key: screamingSnakeKey(item.name ?? item.root),
    value: item.root,
    docs: crateDocs(item),
  };
}

function cargoDependencyEntriesForManifest(manifest: CargoManifest): CargoDependency[] {
  return manifest.dependencies;
}

function cargoDependencyEntry(dependency: CargoDependency): GeneratedEntry {
  return {
    key: screamingSnakeKey(dependency.name),
    value: {
      name: dependency.name,
      version: dependency.version ?? "",
      section: dependency.section,
    },
    docs: cargoDependencyDocs(dependency),
  };
}

function crateDocs(item: CargoManifest): string[] {
  return [
    ...(item.description ? [item.description] : []),
    `Crate: ${item.name ?? item.root}`,
    `Root: ${item.root || "."}`,
    ...(item.version ? [`Version: ${item.version}`] : []),
    `Source: ${item.manifestPath}`,
  ];
}

function cargoDependencyDocs(item: CargoDependency): string[] {
  return [
    `Cargo dependency: ${item.name}`,
    `Section: ${item.section}`,
    ...(item.version ? [`Version: ${item.version}`] : []),
    `Source: ${item.manifestPath}`,
  ];
}

function pythonDependencyEntry(dependency: PythonDependency): GeneratedEntry {
  return {
    key: screamingSnakeKey(dependency.name),
    value: {
      name: dependency.name,
      version: dependency.version ?? "",
      source: dependency.source,
      group: dependency.group,
    },
    docs: pythonDependencyDocs(dependency),
  };
}

function pythonDependencyDocs(item: PythonDependency): string[] {
  return [
    `Python dependency: ${item.name}`,
    `Group: ${item.group}`,
    ...(item.version ? [`Version: ${item.version}`] : []),
    `Source: ${item.source}`,
  ];
}

function uniqueEntries(entries: GeneratedEntry[]): GeneratedEntry[] {
  const counts = new Map<string, number>();
  return entries
    .sort((left, right) => entryValueKey(left.value).localeCompare(entryValueKey(right.value)))
    .map((entry) => {
      const count = counts.get(entry.key) ?? 0;
      counts.set(entry.key, count + 1);
      return count === 0 ? entry : { ...entry, key: `${entry.key}_${count + 1}` };
    });
}

function uniqueEntriesByValue(entries: GeneratedEntry[]): GeneratedEntry[] {
  const seen = new Set<string>();
  return uniqueEntries(
    entries.filter((entry) => {
      const valueKey = entryValueKey(entry.value);
      if (seen.has(valueKey)) return false;
      seen.add(valueKey);
      return true;
    }),
  );
}

function buildAmbientModuleDeclarations(rootDir: string, fixturesDir: string, packages: WorkspacePackage[]): AmbientModuleDeclaration[] {
  const modules = new Map<string, AmbientModuleDeclaration>();
  const ensure = (source: string): AmbientModuleDeclaration => {
    const current = modules.get(source);
    if (current) return current;
    const next: AmbientModuleDeclaration = { source, namedExports: [], defaultExport: true, namespaceExport: true };
    modules.set(source, next);
    return next;
  };

  for (const item of packages) {
    if (!item.name || item.name === "<root>" || isReservedOpenCanonAuthoringModule(item.name)) continue;
    ensure(item.name);
    if (!isReservedOpenCanonAuthoringModule(`${item.name}/*`)) ensure(`${item.name}/*`);
  }

  for (const fixtureFile of fixtureSourceFiles(rootDir, fixturesDir)) {
    const text = readFileSync(fixtureFile, "utf8");
    for (const item of parseImportDeclarations(text)) {
      if (isReservedOpenCanonAuthoringModule(item.source)) continue;
      const declaration = ensure(item.source);
      declaration.defaultExport ||= item.defaultImport;
      declaration.namespaceExport ||= item.namespaceImport;
      declaration.namedExports = uniqueSorted([...declaration.namedExports, ...item.namedImports]);
    }
  }

  return [...modules.values()].sort((left, right) => left.source.localeCompare(right.source));
}

function isReservedOpenCanonAuthoringModule(source: string): boolean {
  return source === "@opencanon/core" || source === "@opencanon/core/testing" || source === "@opencanon/validators" || source === "@opencanon/project";
}

function fixtureSourceFiles(rootDir: string, fixturesDir: string): string[] {
  const fixturesRoot = path.isAbsolute(fixturesDir) ? fixturesDir : path.join(rootDir, fixturesDir);
  return listFiles(
    fixturesRoot,
    (file) => /\.[cm]?[jt]sx?$/.test(file),
    (dir) => /(^|\/)(node_modules|runtime|generated)$/.test(normalizePath(relative(rootDir, dir))),
  );
}

function parseImportDeclarations(text: string): Array<{ source: string; namedImports: string[]; defaultImport: boolean; namespaceImport: boolean }> {
  const imports: Array<{ source: string; namedImports: string[]; defaultImport: boolean; namespaceImport: boolean }> = [];
  const importPattern = /\bimport\s+(?:type\s+)?(?<clause>[\s\S]*?)\s+from\s+["'](?<source>[^"']+)["']/g;
  for (const match of text.matchAll(importPattern)) {
    const source = match.groups?.source;
    const clause = match.groups?.clause?.trim() ?? "";
    if (!source || source.startsWith(".") || source.startsWith("@opencanon/")) continue;
    imports.push({
      source,
      namedImports: namedImportsFromClause(clause),
      defaultImport: hasDefaultImport(clause),
      namespaceImport: /\*\s+as\s+/.test(clause),
    });
  }
  return imports;
}

function namedImportsFromClause(clause: string): string[] {
  const namedBlock = clause.match(/\{(?<body>[\s\S]*?)\}/)?.groups?.body;
  if (!namedBlock) return [];
  return namedBlock
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0]?.trim())
    .filter((value): value is string => Boolean(value) && /^[A-Za-z_$][\w$]*$/.test(value));
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}

function hasDefaultImport(clause: string): boolean {
  if (!clause || clause.startsWith("{") || clause.startsWith("*")) return false;
  return /^[A-Za-z_$][\w$]*/.test(clause);
}

function entryValueKey(value: unknown): string {
  if (isRecord(value) && typeof value.name === "string") return value.name;
  return String(value);
}

function readCargoManifests(rootDir: string): CargoManifest[] {
  return listFiles(rootDir, (file) => path.basename(file) === "Cargo.toml", (dir) => shouldSkipCargoDirectory(rootDir, dir))
    .map((file) => parseCargoManifest(rootDir, file))
    .filter((item): item is CargoManifest => Boolean(item?.name))
    .sort((left, right) => left.root.localeCompare(right.root));
}

function readPythonDependencies(rootDir: string): PythonDependency[] {
  const pyprojectDependencies = listFiles(rootDir, (file) => path.basename(file) === "pyproject.toml", (dir) => shouldSkipPythonDirectory(rootDir, dir)).flatMap((file) =>
    parsePyprojectDependencies(rootDir, file),
  );
  const requirementsDependencies = listFiles(rootDir, (file) => isRequirementsFile(file), (dir) => shouldSkipPythonDirectory(rootDir, dir)).flatMap((file) =>
    parseRequirementsDependencies(rootDir, file),
  );
  return [...pyprojectDependencies, ...requirementsDependencies].sort((left, right) => left.name.localeCompare(right.name));
}

function shouldSkipPythonDirectory(rootDir: string, dir: string): boolean {
  const repoPath = normalizePath(relative(rootDir, dir));
  return (
    repoPath === ".git" ||
    repoPath.startsWith(".git/") ||
    repoPath === ".venv" ||
    repoPath.endsWith("/.venv") ||
    repoPath.includes("/.venv/") ||
    repoPath === "venv" ||
    repoPath.endsWith("/venv") ||
    repoPath.includes("/venv/") ||
    repoPath === "__pycache__" ||
    repoPath.endsWith("/__pycache__") ||
    repoPath.includes("/__pycache__/")
  );
}

function isRequirementsFile(file: string): boolean {
  const name = path.basename(file).toLowerCase();
  const parent = path.basename(path.dirname(file)).toLowerCase();
  return name === "requirements.txt" || (/^requirements[-_.].+\.txt$/.test(name) && parent !== "node_modules");
}

function parsePyprojectDependencies(rootDir: string, pyprojectFile: string): PythonDependency[] {
  const source = normalizePath(relative(rootDir, pyprojectFile));
  const parsed = parseTomlLike(readFileSync(pyprojectFile, "utf8"));
  const output: PythonDependency[] = [];
  const project = parsed.get("project");
  output.push(...pythonDependenciesFromArray(project?.dependencies, source, "project.dependencies"));

  const optional = parsed.get("project.optional-dependencies");
  if (optional) {
    for (const [group, value] of Object.entries(optional)) {
      output.push(...pythonDependenciesFromArray(value, source, `project.optional-dependencies.${group}`));
    }
  }

  const dependencyGroups = parsed.get("dependency-groups");
  if (dependencyGroups) {
    for (const [group, value] of Object.entries(dependencyGroups)) {
      output.push(...pythonDependenciesFromArray(value, source, `dependency-groups.${group}`));
    }
  }

  const poetryDependencies = parsed.get("tool.poetry.dependencies");
  if (poetryDependencies) {
    for (const [name, value] of Object.entries(poetryDependencies)) {
      if (name === "python") continue;
      output.push({
        name: normalizePythonPackageName(name),
        version: pythonDependencyVersion(value),
        source,
        group: "tool.poetry.dependencies",
      });
    }
  }

  const poetryGroups = [...parsed.entries()].filter(([section]) => section.startsWith("tool.poetry.group.") && section.endsWith(".dependencies"));
  for (const [section, values] of poetryGroups) {
    for (const [name, value] of Object.entries(values)) {
      output.push({
        name: normalizePythonPackageName(name),
        version: pythonDependencyVersion(value),
        source,
        group: section,
      });
    }
  }

  return output;
}

function parseRequirementsDependencies(rootDir: string, requirementsFile: string): PythonDependency[] {
  const source = normalizePath(relative(rootDir, requirementsFile));
  return readFileSync(requirementsFile, "utf8")
    .split(/\r?\n/)
    .map((line) => parsePythonRequirement(line, source, requirementsGroup(source)))
    .filter((item): item is PythonDependency => Boolean(item));
}

function requirementsGroup(source: string): string {
  const base = path.posix.basename(source, ".txt");
  return base === "requirements" ? "requirements" : base.replace(/^requirements[-_.]?/, "requirements.");
}

function pythonDependenciesFromArray(value: unknown, source: string, group: string): PythonDependency[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? parsePythonRequirement(item, source, group) : null))
    .filter((item): item is PythonDependency => Boolean(item));
}

function parsePythonRequirement(input: string, source: string, group: string): PythonDependency | null {
  const trimmed = stripPythonRequirementComment(input).trim();
  if (!trimmed || trimmed.startsWith("-") || trimmed.startsWith(".")) return null;
  const withoutMarker = trimmed.split(";")[0]?.trim() ?? "";
  const withoutExtras = withoutMarker.replace(/\[[^\]]*\]/, "");
  const match = withoutExtras.match(/^([A-Za-z0-9_.-]+)\s*(.*)$/);
  if (!match) return null;
  const name = normalizePythonPackageName(match[1] ?? "");
  if (!name) return null;
  return {
    name,
    version: (match[2] ?? "").trim(),
    source,
    group,
  };
}

function stripPythonRequirementComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (char === "#" && !quote) return line.slice(0, index);
  }
  return line;
}

function normalizePythonPackageName(name: string): string {
  return name.trim().toLowerCase().replaceAll("_", "-").replace(/\.+/g, "-");
}

function pythonDependencyVersion(value: unknown): string {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringValue(value.version) ?? stringValue(value.path) ?? stringValue(value.git) ?? "";
  return "";
}

function shouldSkipCargoDirectory(rootDir: string, dir: string): boolean {
  const repoPath = normalizePath(relative(rootDir, dir));
  return repoPath === ".git" || repoPath.startsWith(".git/") || repoPath === "target" || repoPath.endsWith("/target") || repoPath.includes("/target/");
}

function parseCargoManifest(rootDir: string, manifestFile: string): CargoManifest | null {
  const manifestPath = normalizePath(relative(rootDir, manifestFile));
  const root = normalizePath(path.posix.dirname(manifestPath));
  const parsed = parseTomlLike(readFileSync(manifestFile, "utf8"));
  const pkg = parsed.get("package");
  const name = pkg ? stringValue(pkg.name) : undefined;
  if (!name) return null;
  return {
    name,
    description: stringValue(pkg?.description),
    version: stringValue(pkg?.version),
    root: root === "." ? "" : root,
    manifestPath,
    dependencies: cargoDependencies(parsed, manifestPath),
  };
}

function cargoDependencies(parsed: Map<string, Record<string, unknown>>, manifestPath: string): CargoDependency[] {
  return ["dependencies", "dev-dependencies", "build-dependencies", "workspace.dependencies"].flatMap((section) => {
    const values = parsed.get(section);
    if (!values) return [];
    return Object.entries(values).map(([name, value]) => ({
      name,
      section,
      manifestPath,
      version: cargoDependencyVersion(value),
    }));
  });
}

function cargoDependencyVersion(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (isRecord(value)) return stringValue(value.version) ?? (value.workspace === true ? "workspace" : undefined);
  return undefined;
}

function parseTomlLike(source: string): Map<string, Record<string, unknown>> {
  const sections = new Map<string, Record<string, unknown>>();
  let current = "";
  for (const rawLine of source.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
    if (!line) continue;
    const section = line.match(/^\[([A-Za-z0-9_.-]+)\]$/)?.[1];
    if (section) {
      current = section;
      if (!sections.has(current)) sections.set(current, {});
      continue;
    }
    if (!current) continue;
    const equalIndex = line.indexOf("=");
    if (equalIndex === -1) continue;
    const key = line.slice(0, equalIndex).trim().replace(/^"|"$/g, "");
    if (!key) continue;
    sections.get(current)![key] = parseTomlValue(line.slice(equalIndex + 1).trim());
  }
  return sections;
}

function stripTomlComment(line: string): string {
  let quote: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if ((char === '"' || char === "'") && line[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (char === "#" && !quote) return line.slice(0, index);
  }
  return line;
}

function parseTomlValue(value: string): unknown {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1);
  if (value === "true") return true;
  if (value === "false") return false;
  if (value.startsWith("[") && value.endsWith("]")) return parseTomlArray(value);
  if (value.startsWith("{") && value.endsWith("}")) return parseTomlInlineTable(value);
  return value;
}

function parseTomlArray(value: string): unknown[] {
  return splitTomlInlineParts(value.slice(1, -1)).map(parseTomlValue);
}

function parseTomlInlineTable(value: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const body = value.slice(1, -1);
  for (const part of splitTomlInlineParts(body)) {
    const equalIndex = part.indexOf("=");
    if (equalIndex === -1) continue;
    const key = part.slice(0, equalIndex).trim().replace(/^"|"$/g, "");
    if (!key) continue;
    output[key] = parseTomlValue(part.slice(equalIndex + 1).trim());
  }
  return output;
}

function splitTomlInlineParts(value: string): string[] {
  const parts: string[] = [];
  let quote: string | undefined;
  let depth = 0;
  let start = 0;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if ((char === '"' || char === "'") && value[index - 1] !== "\\") {
      quote = quote === char ? undefined : quote ?? char;
      continue;
    }
    if (quote) continue;
    if (char === "[" || char === "{") depth += 1;
    if (char === "]" || char === "}") depth -= 1;
    if (char === "," && depth === 0) {
      parts.push(value.slice(start, index).trim());
      start = index + 1;
    }
  }
  parts.push(value.slice(start).trim());
  return parts.filter(Boolean);
}

function renderProjectTypes(input: {
  packages: GeneratedEntry[];
  packageRoots: GeneratedEntry[];
  importSpecifiers: GeneratedEntry[];
  npmDependencies: GeneratedEntry[];
  crates: GeneratedEntry[];
  crateRoots: GeneratedEntry[];
  cargoDependencies: GeneratedEntry[];
  pythonDependencies: GeneratedEntry[];
}): string {
  return [
    "// Generated by OpenCanon. Do not edit by hand.",
    "import \"@opencanon/core\";",
    "",
    "/** Workspace package names discovered from package.json files. */",
    renderConstObject("Packages", input.packages),
    "",
    "/** Literal union of generated workspace package names. */",
    "export type PackageName = (typeof Packages)[keyof typeof Packages];",
    "/** Literal union of generated workspace package keys. */",
    "export type PackageKey = keyof typeof Packages;",
    "",
    "/** Workspace package root directories keyed the same way as `Packages`. */",
    renderConstObject("PackageRoots", input.packageRoots),
    "",
    "/** Literal union of generated workspace package roots. */",
    "export type PackageRoot = (typeof PackageRoots)[keyof typeof PackageRoots];",
    "/** Literal union of generated package root keys. */",
    "export type PackageRootKey = keyof typeof PackageRoots;",
    "",
    "/** Import specifiers discovered from workspace packages and declared dependencies. */",
    renderConstObject("ImportSpecifiers", input.importSpecifiers),
    "",
    "/** Literal union of generated import specifier strings. */",
    "export type ImportSpecifier = (typeof ImportSpecifiers)[keyof typeof ImportSpecifiers];",
    "/** Literal union of generated import specifier keys. */",
    "export type ImportSpecifierKey = keyof typeof ImportSpecifiers;",
    "",
    "/** npm dependencies discovered from package.json dependency sections. Values include `name` and declared `version`. */",
    renderConstObject("Npm", input.npmDependencies),
    "",
    "/** Literal union of generated npm dependency objects. */",
    "export type NpmDependency = (typeof Npm)[keyof typeof Npm];",
    "/** Literal union of generated npm dependency package names. */",
    "export type NpmDependencyName = NpmDependency[\"name\"];",
    "/** Literal union of generated npm dependency version ranges. */",
    "export type NpmDependencyVersion = NpmDependency[\"version\"];",
    "/** Literal union of generated npm dependency keys. */",
    "export type NpmDependencyKey = keyof typeof Npm;",
    "",
    "/** Rust crate names discovered from Cargo manifests. */",
    renderConstObject("Crates", input.crates),
    "",
    "/** Literal union of generated Rust crate names. */",
    "export type CrateName = (typeof Crates)[keyof typeof Crates];",
    "/** Literal union of generated Rust crate keys. */",
    "export type CrateKey = keyof typeof Crates;",
    "",
    "/** Rust crate root directories keyed the same way as `Crates`. */",
    renderConstObject("CrateRoots", input.crateRoots),
    "",
    "/** Literal union of generated Rust crate roots. */",
    "export type CrateRoot = (typeof CrateRoots)[keyof typeof CrateRoots];",
    "/** Literal union of generated Rust crate root keys. */",
    "export type CrateRootKey = keyof typeof CrateRoots;",
    "",
    "/** Cargo dependencies discovered from dependency sections in Cargo manifests. Values include `name`, `version`, and `section`. */",
    renderConstObject("Cargo", input.cargoDependencies),
    "",
    "/** Literal union of generated Cargo dependency objects. */",
    "export type CargoDependency = (typeof Cargo)[keyof typeof Cargo];",
    "/** Literal union of generated Cargo dependency names. */",
    "export type CargoDependencyName = CargoDependency[\"name\"];",
    "/** Literal union of generated Cargo dependency version requirements. */",
    "export type CargoDependencyVersion = CargoDependency[\"version\"];",
    "/** Literal union of generated Cargo dependency sections. */",
    "export type CargoDependencySection = CargoDependency[\"section\"];",
    "/** Literal union of generated Cargo dependency keys. */",
    "export type CargoDependencyKey = keyof typeof Cargo;",
    "",
    "/** Python dependencies discovered from pyproject.toml and requirements files. Values include `name`, `version`, `source`, and `group`. */",
    renderConstObject("Python", input.pythonDependencies),
    "",
    "/** Literal union of generated Python dependency objects. */",
    "export type PythonDependency = (typeof Python)[keyof typeof Python];",
    "/** Literal union of generated Python dependency names. */",
    "export type PythonDependencyName = PythonDependency[\"name\"];",
    "/** Literal union of generated Python dependency version specifiers. */",
    "export type PythonDependencyVersion = PythonDependency[\"version\"];",
    "/** Literal union of generated Python dependency sources. */",
    "export type PythonDependencySource = PythonDependency[\"source\"];",
    "/** Literal union of generated Python dependency groups. */",
    "export type PythonDependencyGroup = PythonDependency[\"group\"];",
    "/** Literal union of generated Python dependency keys. */",
    "export type PythonDependencyKey = keyof typeof Python;",
    "",
    "/** Lightweight type-only project index. Fact maps are intentionally empty by default to keep editors responsive. */",
    renderProjectIndexType(),
    "",
    "/** Literal union of generated indexed file paths. */",
    "export type ProjectFilePath = keyof ProjectIndex[\"files\"] & string;",
    "/** Import source literals for one indexed file. */",
    "export type ImportSourceIn<F extends ProjectFilePath> = ProjectIndex[\"files\"][F][\"imports\"];",
    "/** Export name literals for one indexed file. */",
    "export type ExportNameIn<F extends ProjectFilePath> = ProjectIndex[\"files\"][F][\"exports\"];",
    "/** Function name literals for one indexed file. */",
    "export type FunctionNameIn<F extends ProjectFilePath> = ProjectIndex[\"files\"][F][\"functions\"];",
    "/** String literal value literals for one indexed file. */",
    "export type StringLiteralIn<F extends ProjectFilePath> = ProjectIndex[\"files\"][F][\"stringLiterals\"];",
    "/** Symbol name literals for one indexed file. */",
    "export type SymbolNameIn<F extends ProjectFilePath> = ProjectIndex[\"files\"][F][\"symbols\"];",
    "/** Call callee literals for one indexed file. */",
    "export type CallNameIn<F extends ProjectFilePath> = ProjectIndex[\"files\"][F][\"calls\"];",
    "",
    "type LookupValues<T> = T extends Record<string, infer V> ? V : never;",
    "type FileLookupValues<T> = T extends Record<string, infer PerFile> ? LookupValues<PerFile> : never;",
    "",
    "/** Generated import records derived from the per-file lookup map. */",
    "export type ProjectImportRecord = FileLookupValues<ProjectIndex[\"imports\"]>;",
    "",
    "/** Generated export records derived from the per-file lookup map. */",
    "export type ProjectExportRecord = FileLookupValues<ProjectIndex[\"exports\"]>;",
    "",
    "/** Generated function records derived from the per-file lookup map. */",
    "export type ProjectFunctionRecord = FileLookupValues<ProjectIndex[\"functions\"]>;",
    "",
    "/** Generated string literal records derived from the per-file lookup map. */",
    "export type ProjectStringLiteralRecord = FileLookupValues<ProjectIndex[\"stringLiterals\"]>;",
    "",
    "/** Generated symbol records derived from the symbol-id lookup map. */",
    "export type ProjectSymbolRecord = LookupValues<ProjectIndex[\"symbols\"]>;",
    "",
    "/** Generated call records derived from the per-file lookup map. */",
    "export type ProjectCallRecord = FileLookupValues<ProjectIndex[\"calls\"]>;",
    "",
    "/** Stable symbol id literals from the generated project index. */",
    "export type ProjectSymbolId = ProjectIndex[\"symbolIds\"];",
    "",
    "declare module \"@opencanon/core\" {",
    "  interface OpenCanonProjectIndex extends ProjectIndex {}",
    "}",
    "",
  ].join("\n");
}

function renderProjectIndexType(): string {
  const lines = ["export type ProjectIndex = {"];
  lines.push("  files: Record<string, import(\"@opencanon/core\").OpenCanonProjectIndexFile>;");
  lines.push("  symbolIds: string;");
  lines.push("  imports: {};");
  lines.push("  exports: {};");
  lines.push("  functions: {};");
  lines.push("  stringLiterals: {};");
  lines.push("  symbols: {};");
  lines.push("  calls: {};");
  lines.push("};");
  return lines.join("\n");
}

function renderRecordType(record: Record<string, unknown>): string {
  return `{ ${Object.entries(record)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join("; ")} }`;
}

function renderStringUnion(values: string[]): string {
  return values.length === 0 ? "never" : values.map((value) => JSON.stringify(value)).join(" | ");
}

function renderConstObject(name: string, entries: GeneratedEntry[]): string {
  const lines = [`export const ${name} = {`];
  for (const entry of entries) {
    lines.push(...renderJsDoc(entry.docs, "  "));
    lines.push(`  ${entry.key}: ${JSON.stringify(entry.value)},`);
  }
  lines.push("} as const;");
  return lines.join("\n");
}

function renderAmbientAliases(modules: AmbientModuleDeclaration[]): string {
  const lines = [
    "// Generated by OpenCanon. Do not edit by hand.",
    "// Ambient declarations for fixture and validator authoring imports.",
    "",
  ];
  for (const item of modules) {
    lines.push(`declare module ${JSON.stringify(item.source)} {`);
    lines.push("  const __opencanonModule: any;");
    if (item.defaultExport) lines.push("  export default __opencanonModule;");
    if (item.namespaceExport) lines.push("  export = __opencanonModule;");
    for (const name of item.namedExports) {
      lines.push(`  export const ${name}: any;`);
    }
    lines.push("}");
    lines.push("");
  }
  return lines.join("\n");
}

function renderJsDoc(lines: string[], indent: string): string[] {
  if (lines.length === 0) return [];
  return [
    `${indent}/**`,
    ...lines.flatMap((line, index) => {
      const text = escapeComment(line);
      return index === 0 ? [`${indent} * ${text}`, `${indent} *`] : [`${indent} * ${text}`];
    }),
    `${indent} */`,
  ];
}

function escapeComment(input: string): string {
  return input.replaceAll("*/", "* /").replace(/\s+/g, " ").trim();
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
