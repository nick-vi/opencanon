import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  CommitApprovalsIgnoreEntries,
  createDefaultConfig,
  GeneratedStateIgnoreEntries,
  OpenCanonAgentEntryFiles,
  patchOpenCanonAgentEntryBlock,
  OpenCanonSkillArtifacts,
  ProjectAliasesFilePath,
  ProjectCoreAuthoringFilePath,
  ProjectTestingAuthoringFilePath,
  ProjectTypesFilePath,
  ProjectValidatorsAuthoringFilePath,
} from "@opencanon/core";

const OpenCanonInitFile = {
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
const TemporaryArtifactIgnoreEntries = ["tmp/"];
const Utf8Encoding = "utf8";

export type InitScaffoldQuery = {
  dryRun: boolean;
  force: boolean;
  missingOnly: boolean;
  docsDir: string;
  conventionsPath: string;
  areasPath: string;
  specsPath: string;
  changesPath: string;
  fixturesDir: string;
  cacheDir: string;
  fileDiscovery: "git" | "filesystem";
};

type InitFileResult = {
  path: string;
  action: InitFileAction;
};

export type InitScaffoldPlanItem = {
  path: string;
  kind: "agent-entry" | "gitignore" | "managed-file" | "package-script";
  required: boolean;
};

type InitScaffoldWritePlanItem =
  | {
      kind: "managed-file";
      path: string;
      content: string;
      required: boolean;
      mode?: number;
    }
  | {
      kind: "agent-entry";
      path: string;
      required: boolean;
    }
  | {
      kind: "gitignore";
      path: ".gitignore";
      entries: string[];
      required: false;
    }
  | {
      kind: "package-script";
      path: "package.json#scripts.opencanon";
      required: true;
    };

export type InitScaffoldResult = {
  rootDir: string;
  dryRun: boolean;
  files: InitFileResult[];
  diagnostics: string[];
  nextSteps: string[];
};

export function runInitScaffold(rootDir: string, query: InitScaffoldQuery): InitScaffoldResult {
  const diagnostics: string[] = [];
  const files: InitFileResult[] = [];

  for (const item of buildInitScaffoldWritePlan(rootDir, query)) {
    if (item.kind === "managed-file") files.push(writeManagedFile(rootDir, item.path, item.content, query, diagnostics, item.mode));
    else if (item.kind === "agent-entry") files.push(writeManagedAgentEntryFile(rootDir, item.path, query, diagnostics));
    else if (item.kind === "gitignore") files.push(writeGitignoreEntries(rootDir, item.entries, query));
    else files.push(writePackageScript(rootDir, query, diagnostics));
  }

  return {
    rootDir,
    dryRun: query.dryRun,
    files,
    diagnostics,
    nextSteps: nextSteps(),
  };
}

export function buildInitScaffoldPlan(rootDir: string, query: InitScaffoldQuery): InitScaffoldPlanItem[] {
  return buildInitScaffoldWritePlan(rootDir, query).map((item) => ({
    path: item.path,
    kind: item.kind,
    required: item.required,
  }));
}

export function missingInitScaffoldFiles(rootDir: string, query: InitScaffoldQuery): string[] {
  return buildInitScaffoldWritePlan(rootDir, query)
    .filter((item) => item.required && !isInitScaffoldItemPresent(rootDir, item))
    .map((item) => item.path);
}

function buildInitScaffoldWritePlan(rootDir: string, query: InitScaffoldQuery): InitScaffoldWritePlanItem[] {
  const items: InitScaffoldWritePlanItem[] = [];
  const config = initConfigOverrides(rootDir, query);

  if (Object.keys(config).length > 0) {
    items.push({
      kind: "managed-file",
      path: "opencanon.config.json",
      content: `${JSON.stringify(config, null, 2)}\n`,
      required: true,
    });
  }

  items.push(
    managedFile(docsPath(query.docsDir, OpenCanonInitFile.Architecture), canonDocTemplate("Architecture"), false),
    managedFile(docsPath(query.docsDir, OpenCanonInitFile.Lifecycle), canonDocTemplate("Lifecycle"), false),
    managedFile(docsPath(query.docsDir, OpenCanonInitFile.Testing), canonDocTemplate("Testing"), false),
    managedFile(docsPath(query.docsDir, OpenCanonInitFile.Impact), canonDocTemplate("Impact"), false),
    managedFile(docsPath(query.docsDir, OpenCanonInitFile.Security), canonDocTemplate("Security"), false),
    managedFile(docsPath(query.docsDir, OpenCanonInitFile.ImpactSurfaces), "[]\n", false),
    managedFile(docsPath(query.docsDir, OpenCanonInitFile.ProposedImpactNotes), "[]\n", false),
    managedFile(query.conventionsPath, conventionsTemplate(), true),
    managedFile(query.areasPath, areasTemplate(), true),
    managedFile(query.specsPath, specsTemplate(), true),
    managedFile(query.changesPath, changesTemplate(), true),
    managedFile(path.join(query.fixturesDir, ".gitkeep"), EmptyFileContent, true),
    managedFile(conventionTsconfigPath(query), conventionTsconfigTemplate(query), true),
    managedFile(fixtureTsconfigPath(query), fixtureTsconfigTemplate(query), true),
    ...OpenCanonSkillArtifacts.map((artifact) => managedFile(artifact.path, artifact.content, true, artifact.mode)),
    ...OpenCanonAgentEntryFiles.map((entryFile): InitScaffoldWritePlanItem => ({ kind: "agent-entry", path: entryFile, required: true })),
    {
      kind: "gitignore",
      path: ".gitignore",
      entries: [
        ...TemporaryArtifactIgnoreEntries,
        `${query.cacheDir.replace(/\/$/, "")}/`,
        ...GeneratedStateIgnoreEntries,
        ...CommitApprovalsIgnoreEntries,
      ],
      required: false,
    },
    {
      kind: "package-script",
      path: "package.json#scripts.opencanon",
      required: true,
    },
  );

  return items;
}

function managedFile(path: string, content: string, required: boolean, mode?: number): InitScaffoldWritePlanItem {
  return {
    kind: "managed-file",
    path,
    content,
    required,
    mode,
  };
}

function isInitScaffoldItemPresent(rootDir: string, item: InitScaffoldWritePlanItem): boolean {
  if (item.kind === "package-script") return packageHasOpenCanonScript(rootDir);
  if (item.kind === "gitignore") return true;
  return existsSync(path.join(rootDir, item.path));
}

function initConfigOverrides(rootDir: string, query: InitScaffoldQuery): Record<string, unknown> {
  const defaults = createDefaultConfig(rootDir);
  const config: Record<string, unknown> = {};
  if (query.docsDir !== defaults.docsDir) {
    config.docsDir = query.docsDir;
    config.impactSurfacesPath = docsPath(query.docsDir, OpenCanonInitFile.ImpactSurfaces);
    config.proposedImpactNotesPath = docsPath(query.docsDir, OpenCanonInitFile.ProposedImpactNotes);
  }
  if (query.conventionsPath !== defaults.conventionsPath) config.conventionsPath = query.conventionsPath;
  if (query.areasPath !== defaults.areasPath) config.areasPath = query.areasPath;
  if (query.specsPath !== defaults.specsPath) config.specsPath = query.specsPath;
  if (query.changesPath !== defaults.changesPath) config.changesPath = query.changesPath;
  if (query.fixturesDir !== defaults.fixturesDir) config.fixturesDir = query.fixturesDir;
  if (query.cacheDir !== defaults.cacheDir) config.cacheDir = query.cacheDir;
  if (query.fileDiscovery !== defaults.fileDiscovery) config.fileDiscovery = query.fileDiscovery;
  return config;
}

function docsPath(docsDir: string, file: OpenCanonInitFile): string {
  return path.join(docsDir, file);
}

function writeManagedFile(
  rootDir: string,
  relativePath: string,
  content: string,
  query: Pick<InitScaffoldQuery, "dryRun" | "force" | "missingOnly">,
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

function writeManagedAgentEntryFile(
  rootDir: string,
  relativePath: string,
  query: Pick<InitScaffoldQuery, "dryRun">,
  diagnostics: string[],
): InitFileResult {
  const filePath = path.join(rootDir, relativePath);
  const exists = existsSync(filePath);
  const current = exists ? readFileSync(filePath, Utf8Encoding) : EmptyFileContent;
  const patched = patchOpenCanonAgentEntryBlock(current);
  diagnostics.push(...patched.diagnostics.map((diagnostic) => `${relativePath}: ${diagnostic}`));
  if (patched.diagnostics.length > 0) return { path: relativePath, action: InitFileAction.Skip };
  if (!patched.changed) return { path: relativePath, action: InitFileAction.Unchanged };

  if (!query.dryRun) {
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, patched.content);
  }
  return { path: relativePath, action: exists ? InitFileAction.Update : InitFileAction.Create };
}

function writeGitignoreEntries(rootDir: string, entries: string[], query: Pick<InitScaffoldQuery, "dryRun">): InitFileResult {
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

function writePackageScript(rootDir: string, query: InitScaffoldQuery, diagnostics: string[]): InitFileResult {
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
  return OpenCanonCommandName;
}

function packageHasOpenCanonScript(rootDir: string): boolean {
  const packageJsonPath = path.join(rootDir, "package.json");
  if (!existsSync(packageJsonPath)) return false;
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, Utf8Encoding)) as { scripts?: Record<string, unknown> };
    return packageJson.scripts?.opencanon === packageScript();
  } catch {
    return false;
  }
}

function nextSteps(): string[] {
  return [
    "Fill the configured conventions entrypoint with docs-only and runtime conventions from the repository's existing canon.",
    "Run opencanon init --yes or start the project runtime so generated project authoring support is created and kept fresh automatically.",
    "Add mechanically checkable conventions in the configured conventions path.",
    "Add opencanon/fixtures/<convention-id>/valid.ts and opencanon/fixtures/<convention-id>/invalid.ts for each runtime convention.",
    "Run opencanon context --check.",
    "Run opencanon validate --check-fixtures.",
    "Run opencanon doctor.",
    "Install feedback hooks with opencanon hook install --all --dry-run.",
  ];
}

function canonDocTemplate(title: string): string {
  return `# ${title}

Add human-readable canon docs here. Link conventions to headings with normalized anchors:

## Example Policy

Write the current policy here, then reference it from a docs-only or runtime convention with an explicit docs ref.
`;
}

function conventionsTemplate(): string {
  return `export default [];
`;
}

function areasTemplate(): string {
  return `export default [];
`;
}

function specsTemplate(): string {
  return `export default [];
`;
}

function changesTemplate(): string {
  return `export default [];
`;
}

function conventionTsconfigPath(query: Pick<InitScaffoldQuery, "conventionsPath">): string {
  return path.posix.join(conventionWorkspaceDir(query.conventionsPath), "tsconfig.json");
}

function fixtureTsconfigPath(query: Pick<InitScaffoldQuery, "fixturesDir">): string {
  return path.posix.join(normalizeConfigPath(query.fixturesDir), "tsconfig.json");
}

function conventionWorkspaceDir(conventionsPath: string): string {
  const sourceDir = path.posix.dirname(normalizeConfigPath(conventionsPath));
  return path.posix.basename(sourceDir) === "conventions" ? path.posix.dirname(sourceDir) : sourceDir;
}

function conventionSourceInclude(conventionsPath: string): string {
  return definitionSourceInclude(conventionWorkspaceDir(conventionsPath), conventionsPath);
}

function areaSourceInclude(query: Pick<InitScaffoldQuery, "conventionsPath" | "areasPath">): string {
  return definitionSourceInclude(conventionWorkspaceDir(query.conventionsPath), query.areasPath);
}

function specSourceInclude(query: Pick<InitScaffoldQuery, "conventionsPath" | "specsPath">): string {
  return definitionSourceInclude(conventionWorkspaceDir(query.conventionsPath), query.specsPath);
}

function changeSourceInclude(query: Pick<InitScaffoldQuery, "conventionsPath" | "changesPath">): string {
  return definitionSourceInclude(conventionWorkspaceDir(query.conventionsPath), query.changesPath);
}

function definitionSourceInclude(workspaceDir: string, definitionPath: string): string {
  const sourceDir = path.posix.dirname(normalizeConfigPath(definitionPath));
  const relativeSourceDir = normalizeConfigPath(path.posix.relative(workspaceDir, sourceDir) || ".");
  return relativeSourceDir === "." ? "**/*.ts" : `${relativeSourceDir}/**/*.ts`;
}

function relativeTsconfigPath(fromDir: string, toPath: string): string {
  const relativePath = normalizeConfigPath(path.posix.relative(normalizeConfigPath(fromDir), normalizeConfigPath(toPath)));
  if (!relativePath) return ".";
  return relativePath.startsWith(".") ? relativePath : `./${relativePath}`;
}

function normalizeConfigPath(input: string): string {
  return input.replace(/\\/g, "/").replace(/^\.\/+/, "") || ".";
}

function conventionTsconfigTemplate(query: Pick<InitScaffoldQuery, "conventionsPath" | "areasPath" | "specsPath" | "changesPath">): string {
  const workspaceDir = conventionWorkspaceDir(query.conventionsPath);
  return `${JSON.stringify(
    {
      compilerOptions: {
        allowImportingTsExtensions: true,
        baseUrl: ".",
        module: "ESNext",
        moduleResolution: "Bundler",
        noEmit: true,
        skipLibCheck: true,
        strict: true,
        target: "ES2022",
        lib: ["ES2023", "DOM", "DOM.Iterable"],
        types: ["node"],
        paths: {
          "@opencanon/core": [relativeTsconfigPath(workspaceDir, ProjectCoreAuthoringFilePath)],
          "@opencanon/core/testing": [relativeTsconfigPath(workspaceDir, ProjectTestingAuthoringFilePath)],
          "@opencanon/validators": [relativeTsconfigPath(workspaceDir, ProjectValidatorsAuthoringFilePath)],
          "@opencanon/project": [relativeTsconfigPath(workspaceDir, ProjectTypesFilePath)],
        },
      },
      include: [
        conventionSourceInclude(query.conventionsPath),
        areaSourceInclude(query),
        specSourceInclude(query),
        changeSourceInclude(query),
        relativeTsconfigPath(workspaceDir, ProjectTypesFilePath),
        relativeTsconfigPath(workspaceDir, ProjectAliasesFilePath),
        relativeTsconfigPath(workspaceDir, ProjectCoreAuthoringFilePath),
        relativeTsconfigPath(workspaceDir, ProjectTestingAuthoringFilePath),
        relativeTsconfigPath(workspaceDir, ProjectValidatorsAuthoringFilePath),
      ],
    },
    null,
    2,
  )}\n`;
}

function fixtureTsconfigTemplate(query: Pick<InitScaffoldQuery, "conventionsPath" | "fixturesDir">): string {
  const fixturesDir = normalizeConfigPath(query.fixturesDir);
  return `${JSON.stringify(
    {
      extends: relativeTsconfigPath(fixturesDir, conventionTsconfigPath(query)),
      compilerOptions: {
        strict: false,
        noImplicitAny: false,
        skipLibCheck: true,
      },
      include: [
        "**/*.ts",
        relativeTsconfigPath(fixturesDir, ProjectAliasesFilePath),
        relativeTsconfigPath(fixturesDir, ProjectCoreAuthoringFilePath),
        relativeTsconfigPath(fixturesDir, ProjectTestingAuthoringFilePath),
      ],
    },
    null,
    2,
  )}\n`;
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
