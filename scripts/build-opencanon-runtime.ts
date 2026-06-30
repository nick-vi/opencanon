import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { build as esbuild } from "esbuild";
import { engineBindingName } from "../packages/engine/src/index.ts";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const defaultRuntimeRoot = path.join(rootDir, "tmp/opencanon-runtime");
const skipEngine = process.argv.includes("--skip-engine");
const bundleNode = process.argv.includes("--bundle-node") || process.env.OPENCANON_BUNDLE_NODE === "1";
const runtimeRoot = resolveRuntimeRoot();
const engineTarget = `${process.platform}-${process.arch}`;
const rootPackage = JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version?: string };

const builds = [
  ["packages/cli/src/index.ts", "cli.js"],
  ["packages/core/src/index.ts", "core.js"],
  ["packages/validators/src/index.ts", "validators.js"],
  ["packages/runtime/src/index.ts", "runtime.js"],
] as const;

removeTree(runtimeRoot);
mkdirSync(runtimeRoot, { recursive: true });
// Mark the runtime as ESM so Node never has to guess the module format of the
// bundled .js (which mixes import + top-level await with shimmed __filename).
writeFileSync(
  path.join(runtimeRoot, "package.json"),
  `${JSON.stringify({ name: "opencanon", version: rootPackage.version ?? "0.0.0-dev", type: "module" }, null, 2)}\n`,
);
copyEsbuildWasm();

for (const [source, target] of builds) {
  await buildRuntimeEntry(path.join(rootDir, source), path.join(runtimeRoot, target), {
    banner: target === "cli.js" ? "#!/usr/bin/env node" : undefined,
  });
}

// The live type-producer is spawned as a SEPARATE child process by the runtime
// runtime, so it needs its own bundled entry next to runtime.js. `typescript`
// stays external — the producer must load the TARGET repo's TS, not ours.
await buildRuntimeEntry(path.join(rootDir, "packages/runtime/src/type-producer/producer-main.ts"), path.join(runtimeRoot, "producer-main.js"), {
  external: ["typescript"],
});

emitRuntimeDeclarations();
if (!skipEngine) copyEngineBinary();
if (bundleNode) copyBundledNode();

console.log(`Built OpenCanon runtime at ${path.relative(rootDir, runtimeRoot)}.`);

async function buildRuntimeEntry(
  entryPoint: string,
  outfile: string,
  options: { banner?: string; external?: string[]; stripSourceComments?: boolean; target?: string } = {},
): Promise<void> {
  await esbuild({
    entryPoints: [entryPoint],
    outfile,
    bundle: true,
    platform: "node",
    format: "esm",
    target: options.target ?? "node24",
    minify: false,
    sourcemap: false,
    // Define a real `require` so esbuild's __require shim uses it instead of
    // throwing "Dynamic require of 'fs' is not supported" when a bundled CJS dep
    // requires a node built-in. The shebang (if any) MUST stay the first line.
    banner: {
      js: [
        options.banner,
        'import { createRequire as __createRequire } from "node:module";',
        'import { fileURLToPath as __fileURLToPath } from "node:url";',
        'import { dirname as __pathDirname } from "node:path";',
        "const require = __createRequire(import.meta.url);",
        "const __filename = __fileURLToPath(import.meta.url);",
        "const __dirname = __pathDirname(__filename);",
      ]
        .filter(Boolean)
        .join("\n"),
    },
    external: options.external ?? [],
  });
  // esbuild preserves the entry's own shebang AND prepends our banner shebang, which
  // yields two `#!` lines (the second is a syntax error). Collapse to a single
  // leading shebang.
  const bundled = readFileSync(outfile, "utf8");
  const deduped = bundled.replace(/^(#![^\n]*\n)(?:#![^\n]*\n)+/, "$1");
  const normalized = options.stripSourceComments ? deduped.replace(/^\/\/ .+\.ts\n/gm, "") : deduped;
  if (normalized !== bundled) writeFileSync(outfile, normalized);
  if (options.banner?.startsWith("#!")) chmodSync(outfile, 0o755);
}

function resolveRuntimeRoot(): string {
  const explicit = stringArg("--runtime-dir") ?? process.env.OPENCANON_BUILD_RUNTIME_DIR;
  if (explicit) return path.resolve(rootDir, explicit);
  if (canWriteRuntime(defaultRuntimeRoot)) return defaultRuntimeRoot;
  throw new Error(`Default OpenCanon runtime path is not writable: ${path.relative(rootDir, defaultRuntimeRoot)}.`);
}

function stringArg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index >= 0) return process.argv[index + 1];
  const prefix = `${name}=`;
  return process.argv.find((arg) => arg.startsWith(prefix))?.slice(prefix.length);
}

function canWriteRuntime(target: string): boolean {
  try {
    mkdirSync(target, { recursive: true });
    const probe = path.join(target, `.write-check-${process.pid}`);
    writeFileSync(probe, "");
    unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

function copyEngineBinary(): void {
  // Single source of truth for the napi suffix lives in @opencanon/engine.
  const fileName = engineBindingName("opencanon", process.platform, process.arch);
  const source = path.join(rootDir, "packages/engine/binaries", fileName);
  if (!existsSync(source)) throw new Error(`Missing engine binary ${source}. Run npm run build:engine before building the OpenCanon runtime.`);

  const target = path.join(runtimeRoot, "engine", engineTarget, fileName);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyBundledNode(): void {
  const source = path.resolve(rootDir, stringArg("--node-binary") ?? process.env.OPENCANON_BUNDLED_NODE ?? process.execPath);
  if (!existsSync(source)) throw new Error(`Missing bundled Node binary ${source}.`);
  const target = path.join(runtimeRoot, "node", "bin", nodeBinaryName());
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
  if (process.platform !== "win32") chmodSync(target, 0o755);
  if (process.platform === "darwin") copyDarwinNodeDependencies(source, target);
}

function copyDarwinNodeDependencies(sourceBinary: string, targetBinary: string): void {
  const sourceByTarget = new Map<string, string>();
  const queue: string[] = [sourceBinary];
  const copiedTargets = new Set<string>([targetBinary]);
  const targetLibDir = path.join(runtimeRoot, "node", "lib");
  mkdirSync(targetLibDir, { recursive: true });
  ensureDarwinRpath(targetBinary, "@loader_path/../lib");

  for (let index = 0; index < queue.length; index += 1) {
    const source = queue[index];
    const target = source === sourceBinary ? targetBinary : path.join(targetLibDir, path.basename(source));
    const dependencies = darwinDependencies(source);
    for (const dependency of dependencies) {
      const resolved = resolveDarwinDependency(source, dependency);
      if (!resolved || !shouldBundleDarwinDependency(resolved)) continue;
      const dependencyTarget = path.join(targetLibDir, path.basename(resolved));
      if (!existsSync(dependencyTarget)) {
        copyFileSync(resolved, dependencyTarget);
        chmodSync(dependencyTarget, 0o755);
      }
      sourceByTarget.set(dependencyTarget, resolved);
      if (!copiedTargets.has(dependencyTarget)) {
        copiedTargets.add(dependencyTarget);
        queue.push(resolved);
      }
      changeDarwinDependency(target, dependency, `@rpath/${path.basename(resolved)}`);
    }
    if (target !== targetBinary) {
      ensureDarwinDylibId(target, `@rpath/${path.basename(target)}`);
      ensureDarwinRpath(target, "@loader_path");
    }
  }

  for (const [target, source] of sourceByTarget) {
    for (const dependency of darwinDependencies(source)) {
      const resolved = resolveDarwinDependency(source, dependency);
      if (!resolved || !shouldBundleDarwinDependency(resolved)) continue;
      changeDarwinDependency(target, dependency, `@rpath/${path.basename(resolved)}`);
    }
  }

  for (const target of [...copiedTargets].filter((item) => item !== targetBinary)) signDarwinBinary(target);
  signDarwinBinary(targetBinary);
}

function darwinDependencies(binary: string): string[] {
  const result = spawnSync("otool", ["-L", binary], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`Could not inspect bundled Node dependency ${binary}: ${result.stderr || result.stdout}`);
  return result.stdout
    .split(/\r?\n/u)
    .slice(1)
    .map((line) => line.match(/^\s+(.+?)\s+\(/u)?.[1])
    .filter((value): value is string => Boolean(value));
}

function resolveDarwinDependency(fromBinary: string, dependency: string): string | undefined {
  if (dependency.startsWith("/")) return existsSync(dependency) ? realpathSync(dependency) : undefined;
  if (dependency.startsWith("@loader_path/")) {
    const candidate = path.resolve(path.dirname(fromBinary), dependency.slice("@loader_path/".length));
    return existsSync(candidate) ? realpathSync(candidate) : undefined;
  }
  if (dependency.startsWith("@executable_path/")) {
    const candidate = path.resolve(path.dirname(sourceBinaryPath()), dependency.slice("@executable_path/".length));
    return existsSync(candidate) ? realpathSync(candidate) : undefined;
  }
  if (!dependency.startsWith("@rpath/")) return undefined;
  const name = dependency.slice("@rpath/".length);
  const candidates = [
    path.join(path.dirname(fromBinary), name),
    path.join(path.dirname(fromBinary), "..", "lib", name),
    path.join(path.dirname(realpathSync(fromBinary)), name),
    path.join(path.dirname(realpathSync(fromBinary)), "..", "lib", name),
    path.join("/opt/homebrew/lib", name),
    path.join("/usr/local/lib", name),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function sourceBinaryPath(): string {
  return path.resolve(rootDir, stringArg("--node-binary") ?? process.env.OPENCANON_BUNDLED_NODE ?? process.execPath);
}

function shouldBundleDarwinDependency(file: string): boolean {
  return !file.startsWith("/usr/lib/") && !file.startsWith("/System/");
}

function ensureDarwinDylibId(file: string, id: string): void {
  runInstallNameTool(["-id", id, file], `Could not set bundled Node dylib id for ${file}.`);
}

function ensureDarwinRpath(file: string, rpath: string): void {
  const loadCommands = spawnSync("otool", ["-l", file], { encoding: "utf8" });
  if (loadCommands.status === 0 && loadCommands.stdout.includes(`path ${rpath} `)) return;
  runInstallNameTool(["-add_rpath", rpath, file], `Could not add bundled Node rpath ${rpath} to ${file}.`, true);
}

function changeDarwinDependency(file: string, from: string, to: string): void {
  if (from === to) return;
  runInstallNameTool(["-change", from, to, file], `Could not rewrite bundled Node dependency ${from} in ${file}.`);
}

function runInstallNameTool(args: string[], message: string, allowDuplicateRpath = false): void {
  const result = spawnSync("install_name_tool", args, { encoding: "utf8" });
  if (result.status === 0) return;
  const output = `${result.stdout}\n${result.stderr}`;
  if (allowDuplicateRpath && /would duplicate path|already exists/i.test(output)) return;
  throw new Error(`${message}\n${output.trim()}`);
}

function signDarwinBinary(file: string): void {
  const result = spawnSync("codesign", ["--force", "--sign", "-", file], { encoding: "utf8" });
  if (result.status === 0) return;
  throw new Error(`Could not ad-hoc sign bundled Node binary ${file}.\n${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`);
}

function nodeBinaryName(): string {
  return process.platform === "win32" ? "node.exe" : "node";
}

function copyEsbuildWasm(): void {
  const source = path.join(rootDir, "node_modules/esbuild-wasm/esbuild.wasm");
  if (!existsSync(source)) throw new Error(`Missing ${source}. Run npm install before building the OpenCanon runtime.`);
  copyFileSync(source, path.join(runtimeRoot, "esbuild.wasm"));
}

function removeTree(target: string): void {
  if (!existsSync(target)) return;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    const entryPath = path.join(target, entry.name);
    if (entry.isDirectory()) removeTree(entryPath);
    else unlinkSync(entryPath);
  }
  rmdirSync(target);
}

function emitRuntimeDeclarations(): void {
  const typesRoot = path.join(runtimeRoot, "types");
  removeTree(typesRoot);
  mkdirSync(typesRoot, { recursive: true });

  emitPackageDeclarations("core", "packages/core/src/index.ts");
  emitPackageDeclarations("validators", "packages/validators/src/index.ts");
  removeSourceDeclarationArtifacts("core");
  removeSourceDeclarationArtifacts("validators");

  writeFileSync(path.join(runtimeRoot, "core.d.ts"), 'export * from "./types/core/index.js";\n');
  writeFileSync(path.join(runtimeRoot, "validators.d.ts"), 'export * from "./types/validators/index.js";\n');
  writeFileSync(path.join(runtimeRoot, "core.js.d.ts"), 'export * from "./types/core/index.js";\n');
  writeFileSync(path.join(runtimeRoot, "validators.js.d.ts"), 'export * from "./types/validators/index.js";\n');
}

function emitPackageDeclarations(name: string, entrypoint: string): void {
  const outDir = path.join(runtimeRoot, "types", name);
  const tsconfigPath = path.join(runtimeRoot, `.tsconfig.${name}.json`);
  writeFileSync(
    tsconfigPath,
    `${JSON.stringify(
      {
        compilerOptions: {
          allowImportingTsExtensions: true,
          declaration: true,
          emitDeclarationOnly: true,
          module: "ESNext",
          moduleResolution: "Bundler",
          noCheck: true,
          noEmit: false,
          outDir,
          rootDir: path.join(rootDir, packageSourceRoot(name)),
          skipLibCheck: true,
          target: "ES2022",
          types: ["node"],
          paths: {
            "@opencanon/core": [path.join(rootDir, "packages/core/src/index.ts")],
            "@opencanon/core/testing": [path.join(rootDir, "packages/core/src/testing.ts")],
            "@opencanon/validators": [path.join(rootDir, "packages/validators/src/index.ts")],
          },
        },
        files: [path.join(rootDir, entrypoint)],
      },
      null,
      2,
    )}\n`,
  );
  try {
    run(process.execPath, [path.join(rootDir, "node_modules/typescript/bin/tsc"), "--project", tsconfigPath]);
  } finally {
    rmSync(tsconfigPath, { force: true });
  }
  rewriteDeclarationImports(outDir);
}

function packageSourceRoot(name: string): string {
  if (name === "core") return "packages/core/src";
  if (name === "validators") return "packages/validators/src";
  throw new Error(`Unknown declaration package: ${name}`);
}

function rewriteDeclarationImports(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      rewriteDeclarationImports(entryPath);
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    const source = readFileSync(entryPath, "utf8");
    writeFileSync(entryPath, source.replace(/(\.\/[^"']+)\.ts(["'])/g, "$1.js$2"));
  }
}

function removeSourceDeclarationArtifacts(name: string): void {
  const sourceRoot = path.join(rootDir, packageSourceRoot(name));
  if (!existsSync(sourceRoot)) return;
  for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".d.ts")) continue;
    if (name === "core" && entry.name === "picomatch.d.ts") continue;
    rmSync(path.join(sourceRoot, entry.name), { force: true });
  }
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8", stdio: "pipe" });
  if (result.status === 0) return;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(output || `Command failed: ${command} ${args.join(" ")}`);
}
