import { mkdirSync, writeFileSync, existsSync, readFileSync, statSync, realpathSync, renameSync, rmSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cac } from "cac";
import { fail, resolveRootDir, membershipHashOf, listMembershipFiles } from "@opencanon/core";
import type { SidecarEntry, SidecarPayload, SidecarSourceFile } from "@opencanon/core";
import { CliOptionFlag, CliOptionName, booleanOption, rejectUnknownOptions } from "./options.ts";

export async function runAnalyzeCommand(args = process.argv.slice(2), cwd = process.cwd()): Promise<void> {
  const cli = cac("opencanon analyze");
  cli.option(CliOptionFlag.Help, "Show help.");
  cli.option("--typed", "Build the typed-comparisons sidecar via tsc.");
  cli.option("--tsconfig <path>", "Path to tsconfig.json (default: ./tsconfig.json).");
  const parsed = cli.parse(["node", "opencanon", ...args], { run: false });
  const options = parsed.options as Record<string, unknown>;
  rejectUnknownOptions(options, [CliOptionName.Help, CliOptionName.H, "typed", "tsconfig"]);

  if (booleanOption(options.help) || booleanOption(options.h)) {
    console.log(`Usage:\n  opencanon analyze --typed [--tsconfig path]\n\nWrites .opencanon/cache/typed-comparisons.json (the headless/CI TypeScript type-producer sidecar).`);
    return;
  }
  if (!booleanOption(options.typed)) fail("opencanon analyze currently supports only --typed.");

  const rootDir = resolveRootDir(cwd);
  const tsconfigPath = typeof options.tsconfig === "string" ? path.resolve(cwd, options.tsconfig) : path.join(rootDir, "tsconfig.json");
  // C3: prove the tsconfig is root-contained BEFORE any filesystem access — a
  // `--tsconfig ../..` must not even read/parse files outside the project root.
  const tsconfigRel = path.relative(rootDir, tsconfigPath).replace(/\\/g, "/") || path.basename(tsconfigPath);
  if (path.isAbsolute(tsconfigRel) || tsconfigRel.startsWith("../")) {
    fail(`--tsconfig must live inside the project root (${rootDir}); got ${tsconfigPath}`);
  }
  if (!existsSync(tsconfigPath)) fail(`tsconfig not found: ${tsconfigPath}`);

  const { entries, sourceFiles, tsVersion, coverage } = await collectTypedComparisonEntries({ rootDir, tsconfigPath });
  for (const sf of sourceFiles) {
    if (path.isAbsolute(sf.path) || sf.path.startsWith("../")) {
      fail(`Refusing to write a sidecar referencing a path outside the project root: ${sf.path}`);
    }
  }
  const payload: SidecarPayload = {
    version: 1,
    generatedAt: new Date().toISOString(),
    tsconfigPath: tsconfigRel,
    tsconfigHash: createHash("sha256").update(readFileSync(tsconfigPath, "utf8")).digest("hex"),
    tsVersion,
    gitHead: gitHead(rootDir),
    sourceFiles,
    membershipHash: membershipHashOf(listMembershipFiles(rootDir)),
    coverage,
    entries,
  };
  const outDir = path.join(rootDir, ".opencanon", "cache");
  mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "typed-comparisons.json");
  // Atomic publish: write to a per-process temp file in the SAME directory, then
  // rename over the target (rename is atomic within a filesystem). A crash or a
  // concurrent `analyze --typed` can never leave a truncated/half-written sidecar
  // that the reader would parse as fresh — readers see either the old file or the
  // fully-written new one.
  const tmpPath = path.join(outDir, `.typed-comparisons.${process.pid}.tmp.json`);
  try {
    writeFileSync(tmpPath, JSON.stringify(payload, null, 2));
    renameSync(tmpPath, outPath);
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // best-effort cleanup
    }
    throw error;
  }
  const ratio = coverage.comparisonSites === 0 ? 0 : Math.round((coverage.checkedSites / coverage.comparisonSites) * 100);
  console.log(
    `Wrote ${outPath}\n` +
      `Program files: ${coverage.programFiles}\n` +
      `Comparison sites: ${coverage.comparisonSites}\n` +
      `Typed (checked): ${coverage.checkedSites} (${ratio}% of comparison sites)\n` +
      `Fingerprinted files: ${sourceFiles.length}`,
  );
}

async function collectTypedComparisonEntries(params: { rootDir: string; tsconfigPath: string }): Promise<{
  entries: SidecarEntry[];
  sourceFiles: SidecarSourceFile[];
  tsVersion: string;
  coverage: { programFiles: number; comparisonSites: number; checkedSites: number };
}> {
  const ts = await import("typescript").catch(() => null);
  if (!ts) fail("`typescript` is not installed in this workspace; install it as a devDependency to use --typed.");

  // Phase B AST walk: build the program once, walk every StringLiteral whose
  // parent is a BinaryExpression (===/!==/==/!=), call checker.getTypeAtLocation
  // on the opposite operand, record file/line/column/typeName.
  const TS = ts!;
  // Record the EXACT config files TypeScript reads while resolving the extends
  // graph — this is ground truth, unlike a require.resolve guess which can diverge
  // from TS's own config resolution (package exports/typesVersions etc.).
  const configFilesRead = new Set<string>();
  const recordingReadFile = (file: string, encoding?: string): string | undefined => {
    if (file.endsWith(".json")) configFilesRead.add(path.resolve(file));
    return TS.sys.readFile(file, encoding);
  };
  const read = TS.readConfigFile(params.tsconfigPath, recordingReadFile);
  if (read.error) {
    fail(`Could not read ${params.tsconfigPath}: ${TS.flattenDiagnosticMessageText(read.error.messageText, "\n")}`);
  }
  const parsed = TS.parseJsonConfigFileContent(
    read.config ?? {},
    { ...TS.sys, readFile: recordingReadFile },
    path.dirname(params.tsconfigPath),
    undefined,
    params.tsconfigPath,
  );
  if (parsed.errors.length > 0) {
    const messages = parsed.errors.map((d) => TS.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n  ");
    fail(`tsconfig parse errors in ${params.tsconfigPath}:\n  ${messages}`);
  }
  if (parsed.fileNames.length === 0) {
    fail(`tsconfig ${params.tsconfigPath} resolved zero source files. Check 'include'/'files'/'exclude'.`);
  }
  // Record every non-node_modules .json TS reads during program build: workspace
  // package.json (`types`/`exports` redirects) AND referenced-project tsconfigs.
  // Both can change the type of an existing comparison site without touching any
  // source file or membership — fingerprinting the exact set tsc consulted closes
  // those stale-checked vectors.
  const resolutionManifests = new Set<string>();
  const host = TS.createCompilerHost(parsed.options, true);
  const hostReadFile = host.readFile.bind(host);
  host.readFile = (file: string) => {
    if (file.endsWith(".json") && !file.includes("node_modules")) resolutionManifests.add(path.resolve(file));
    return hostReadFile(file);
  };
  // Pass projectReferences so composite/referenced projects enter the program and
  // their sources/configs are reached (and thus fingerprinted), not silently dropped.
  const program = TS.createProgram({
    rootNames: parsed.fileNames,
    options: parsed.options,
    projectReferences: parsed.projectReferences,
    host,
  });
  // Belt-and-suspenders: fingerprint each referenced tsconfig path explicitly, in
  // case TS resolved it through a path that bypassed the host readFile.
  for (const ref of parsed.projectReferences ?? []) resolutionManifests.add(path.resolve(ref.path.endsWith(".json") ? ref.path : path.join(ref.path, "tsconfig.json")));
  // Composite/reference boundary: createProgram CONSUMES referenced projects'
  // emitted .d.ts (it does not build them). Those outputs are fingerprinted, so
  // the sidecar matches tsc's current as-built view — same semantics as running
  // tsc without --build. If a referenced project's source changed but its .d.ts
  // wasn't rebuilt, rebuild references before analyze for fresh outputs.
  if ((parsed.projectReferences ?? []).length > 0) {
    console.warn("[opencanon] tsconfig project references detected: referenced .d.ts outputs are trusted as-built. Run `tsc --build` before `analyze --typed` for fresh declarations.");
  }
  const configDiagnostics = program.getConfigFileParsingDiagnostics();
  if (configDiagnostics.length > 0) {
    const messages = configDiagnostics.map((d) => TS.flattenDiagnosticMessageText(d.messageText, "\n")).join("\n  ");
    fail(`tsc program setup errors:\n  ${messages}`);
  }
  const checker = program.getTypeChecker();
  const entries: SidecarEntry[] = [];
  const sourceFiles: SidecarSourceFile[] = [];
  const fingerprinted = new Set<string>();
  let comparisonSiteCount = 0;

  // External-dependency test by REAL path, not the substring "node_modules": a
  // workspace package symlinked into node_modules (pnpm/workspaces) resolves to a
  // real path with no node_modules segment, so its source IS fingerprinted. A true
  // dependency's real path keeps a node_modules segment and is skipped.
  const isExternal = (file: string): boolean => {
    let real = file;
    try {
      real = realpathSync(file);
    } catch {
      // unresolvable — fall back to the literal path check
    }
    return real.split(path.sep).includes("node_modules");
  };

  const relativeToRoot = (absPath: string): string | null => {
    const relativePath = path.relative(params.rootDir, absPath).replace(/\\/g, "/");
    if (relativePath === "" || path.isAbsolute(relativePath) || relativePath.startsWith("../")) return null;
    return relativePath;
  };

  const fingerprint = (absPath: string): boolean => {
    const relativePath = relativeToRoot(absPath);
    if (!relativePath) return false;
    if (fingerprinted.has(relativePath)) return true;
    fingerprinted.add(relativePath);
    // Hash raw file bytes (NOT sourceFile.text, which TS may normalize) so the
    // reader's readFileSync-based hash matches exactly.
    const stat = statSync(absPath);
    sourceFiles.push({
      path: relativePath,
      sha256: createHash("sha256").update(readFileSync(absPath)).digest("hex"),
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
    return true;
  };

  // Soundness: fingerprint everything that can change the type meaning of a
  // recorded comparison site — not just the comparison files themselves.
  //   1. Local .d.ts the program read (ambient/declared types).
  //   2. The tsconfig extends chain (strict flags, paths, etc.).
  // Editing any of these now invalidates the sidecar instead of silently
  // serving a stale "checked" type.
  for (const sourceFile of program.getSourceFiles()) {
    if (isExternal(sourceFile.fileName)) continue;
    if (!relativeToRoot(sourceFile.fileName)) {
      if (sourceFile.isDeclarationFile) continue;
      fail(`Refusing to write a sidecar referencing a path outside the project root: ${sourceFile.fileName}`);
    }
    if (sourceFile.isDeclarationFile) fingerprint(sourceFile.fileName);
  }
  // Exact tsconfig graph TypeScript actually loaded (ground truth, not a guess).
  for (const configPath of configFilesRead) {
    if (!fingerprint(configPath)) fail(`Refusing to write a sidecar referencing a path outside the project root: ${configPath}`);
  }
  // Dependency manifests: a lockfile/root package.json change can swap @types or
  // resolution without touching any tracked source. Content-verified like the rest.
  for (const manifest of dependencyManifests(params.rootDir)) fingerprint(manifest);
  // Every (non-node_modules) .json tsc consulted during program build — workspace
  // package.json (types/exports redirects) + referenced-project tsconfigs.
  for (const manifest of resolutionManifests) {
    if (existsSync(manifest) && relativeToRoot(manifest)) fingerprint(manifest);
  }

  // Soundness boundary: the reader detects ADDED type-relevant files via a
  // git-derived membership hash. Files TypeScript includes but git cannot see
  // (git-ignored generated .d.ts under an included dir) are invisible to that
  // proxy — adding a sibling later would evade membership-drift. Warn so the
  // operator knows the index must be rebuilt fresh in that setup.
  const gitVisible = new Set(listMembershipFiles(params.rootDir).map((f) => path.resolve(params.rootDir, f)));
  const invisibleIncluded = program
    .getSourceFiles()
    .map((sf) => sf.fileName)
    .filter((f) => !isExternal(f) && relativeToRoot(f) && !gitVisible.has(path.resolve(f)) && MembershipExtensions.test(f));
  if (invisibleIncluded.length > 0) {
    console.warn(
      `[opencanon] ${invisibleIncluded.length} type-relevant file(s) are included by tsconfig but invisible to git ` +
        `(e.g. generated/ignored .d.ts). Membership drift cannot detect NEW such files; rebuild the index after generating them. ` +
        `First: ${path.relative(params.rootDir, invisibleIncluded[0])}`,
    );
  }

  const comparisons = new Set([
    TS.SyntaxKind.EqualsEqualsEqualsToken,
    TS.SyntaxKind.ExclamationEqualsEqualsToken,
    TS.SyntaxKind.EqualsEqualsToken,
    TS.SyntaxKind.ExclamationEqualsToken,
  ]);

  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) continue;
    if (isExternal(sourceFile.fileName)) continue;
    const relativePath = relativeToRoot(sourceFile.fileName);
    if (!relativePath) fail(`Refusing to write a sidecar referencing a path outside the project root: ${sourceFile.fileName}`);
    const sourceRelativePath = relativePath;
    fingerprint(sourceFile.fileName);
    visit(sourceFile);

    function visit(node: import("typescript").Node): void {
      if (TS.isBinaryExpression(node) && comparisons.has(node.operatorToken.kind)) {
        consider(node.left, node.right, sourceRelativePath, sourceFile);
        consider(node.right, node.left, sourceRelativePath, sourceFile);
      }
      TS.forEachChild(node, visit);
    }

    function consider(
      literalSide: import("typescript").Node,
      typedSide: import("typescript").Node,
      file: string,
      sf: import("typescript").SourceFile,
    ): void {
      if (!TS.isStringLiteral(literalSide)) return;
      comparisonSiteCount += 1;
      const type = checker.getTypeAtLocation(typedSide);
      const typeName = checker.typeToString(type);
      if (!typeName || typeName === "string" || typeName === "any" || typeName === "unknown") return;
      const { line, character } = sf.getLineAndCharacterOfPosition(literalSide.getStart(sf));
      const resolved = extractResolution(TS, checker, type, typedSide, typeName);
      entries.push({ file, line: line + 1, column: character + 1, ...resolved });
    }
  }
  return {
    entries,
    sourceFiles,
    tsVersion: TS.version,
    coverage: {
      programFiles: program.getSourceFiles().filter((sf) => !isExternal(sf.fileName) && relativeToRoot(sf.fileName) && !sf.isDeclarationFile).length,
      comparisonSites: comparisonSiteCount,
      checkedSites: entries.length,
    },
  };
}

const MembershipExtensions = /\.(ts|tsx|mts|cts)$/;

type SerializedResolution = Pick<SidecarEntry, "display" | "symbolId" | "typeSource" | "kind" | "members" | "syntax">;

/**
 * Map a tsc `Type` into the serialized `TypeResolution` fields. When the type
 * is a union of string/number/boolean literal types, an enum, or an `as const`
 * object member type, emit `kind:"literal-union"` with enumerated members.
 * Falls back to `kind:"other"` whenever extraction is uncertain.
 *
 * Shared shape with the runtime live producer (packages/runtime type-producer);
 * kept in sync by the current sidecar/RPC contract.
 */
export function extractResolution(
  TS: typeof import("typescript"),
  checker: import("typescript").TypeChecker,
  type: import("typescript").Type,
  node: import("typescript").Node,
  display: string,
): SerializedResolution {
  const symbolId = type.getSymbol()?.getName();
  // flow-narrowed: the apparent type at the node differs from the declared type.
  let typeSource: SidecarEntry["typeSource"] = "declared";
  try {
    // Covers identifiers and simple property accesses (e.g. `state.kind`);
    // other expression forms keep "declared". Mirrors the live producer.
    const declared = TS.isIdentifier(node) || TS.isPropertyAccessExpression(node) ? checker.getSymbolAtLocation(node) : undefined;
    if (declared) {
      const declaredType = checker.getTypeOfSymbolAtLocation(declared, node);
      if (declaredType !== type && checker.typeToString(declaredType) !== display) typeSource = "flow-narrowed";
    }
  } catch {
    // best-effort only
  }
  const other: SerializedResolution = { display, symbolId, typeSource, kind: "other" };

  const members = literalMembers(TS, checker, type);
  if (!members) return other;
  return { display, symbolId, typeSource, kind: "literal-union", members: members.members, syntax: members.syntax };
}

type Member = { name?: string; value?:
  | { kind: "string"; value: string }
  | { kind: "number"; value: number }
  | { kind: "boolean"; value: boolean }
  | { kind: "null" }
  | { kind: "symbolic"; display: string };
  display: string };

/** Enumerate the literal members of a union/enum/const-object type, or undefined when not a finite literal set. */
function literalMembers(
  TS: typeof import("typescript"),
  checker: import("typescript").TypeChecker,
  type: import("typescript").Type,
): { members: Member[]; syntax: SidecarEntry["syntax"] } | undefined {
  const Flags = TS.TypeFlags;
  const isEnumLike = Boolean(type.flags & Flags.EnumLike);
  const arms = (type as import("typescript").UnionType).isUnion?.() ? (type as import("typescript").UnionType).types : [type];
  const members: Member[] = [];
  let sawEnumMember = false;
  for (const arm of arms) {
    const m = literalMemberOf(TS, checker, arm);
    if (!m) return undefined; // any non-literal arm disqualifies the whole set
    if (arm.flags & (Flags.EnumLiteral | Flags.Enum)) sawEnumMember = true;
    members.push(m);
  }
  if (members.length === 0) return undefined;
  const syntax: SidecarEntry["syntax"] = isEnumLike || sawEnumMember ? "ts-enum" : "ts-union";
  return { members, syntax };
}

function literalMemberOf(
  TS: typeof import("typescript"),
  checker: import("typescript").TypeChecker,
  arm: import("typescript").Type,
): Member | undefined {
  const Flags = TS.TypeFlags;
  const name = arm.symbol?.getName();
  if (arm.flags & Flags.StringLiteral) {
    const value = (arm as import("typescript").StringLiteralType).value;
    return { name, value: { kind: "string", value }, display: JSON.stringify(value) };
  }
  if (arm.flags & Flags.NumberLiteral) {
    const value = (arm as import("typescript").NumberLiteralType).value;
    return { name, value: { kind: "number", value }, display: String(value) };
  }
  if (arm.flags & Flags.BooleanLiteral) {
    const display = checker.typeToString(arm);
    return { name, value: { kind: "boolean", value: display === "true" }, display };
  }
  if (arm.flags & Flags.Null) return { name, value: { kind: "null" }, display: "null" };
  if (arm.flags & (Flags.EnumLiteral | Flags.Enum)) {
    // Enum member: its literal backing value is on the type itself.
    const lit = arm as import("typescript").LiteralType;
    const raw = (lit as { value?: string | number }).value;
    const value =
      typeof raw === "string" ? ({ kind: "string", value: raw } as const)
      : typeof raw === "number" ? ({ kind: "number", value: raw } as const)
      : undefined;
    return { name, value, display: checker.typeToString(arm) };
  }
  return undefined;
}

/** Common lockfiles + root package.json — changes here can shift @types / resolution. */
function dependencyManifests(rootDir: string): string[] {
  const candidates = ["package.json", "bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"];
  return candidates.map((name) => path.join(rootDir, name)).filter((p) => existsSync(p));
}

function gitHead(rootDir: string): string {
  try {
    const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: rootDir, encoding: "utf8" });
    return result.status === 0 ? result.stdout.trim() : "";
  } catch {
    return "";
  }
}
