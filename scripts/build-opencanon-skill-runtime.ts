import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const skillRoot = path.join(rootDir, ".agents/skills/opencanon");
const runtimeRoot = path.join(skillRoot, "runtime");
const skipEngine = process.argv.includes("--skip-engine");
const engineTarget = `${process.platform}-${process.arch}`;
const engineBindingSuffixes: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
  "win32-x64": "win32-x64-msvc",
};

const builds = [
  ["packages/cli/src/index.ts", "runtime/cli.js"],
  ["packages/core/src/index.ts", "runtime/core.js"],
  ["packages/validators/src/index.ts", "runtime/validators.js"],
  ["packages/daemon/src/index.ts", "runtime/daemon.js"],
] as const;

rmSync(runtimeRoot, { recursive: true, force: true });
mkdirSync(runtimeRoot, { recursive: true });

for (const [source, target] of builds) {
  run(process.execPath, [
    "build",
    path.join(rootDir, source),
    "--target=bun",
    "--format=esm",
    `--outfile=${path.join(skillRoot, target)}`,
  ]);
}

emitRuntimeDeclarations();
copyDirectory(path.join(rootDir, "packages/ui/dist"), path.join(runtimeRoot, "ui"), "Run bun run ui:build before building the skill runtime.");
if (!skipEngine) copyEngineBinary();

console.log("Built OpenCanon skill runtime.");

function copyEngineBinary(): void {
  const suffix = engineBindingSuffixes[engineTarget];
  if (!suffix) throw new Error(`Unsupported engine target: ${engineTarget}`);
  const fileName = `opencanon.${suffix}.node`;
  const source = path.join(rootDir, "packages/engine/binaries", fileName);
  if (!existsSync(source)) throw new Error(`Missing engine binary ${source}. Run bun run build:engine before building the skill runtime.`);

  const relativePath = path.posix.join("runtime/engine", engineTarget, fileName);
  const target = path.join(skillRoot, relativePath);
  mkdirSync(path.dirname(target), { recursive: true });
  copyFileSync(source, target);
}

function copyDirectory(source: string, target: string, missingMessage: string): void {
  if (!existsSync(source)) throw new Error(missingMessage);
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const sourcePath = path.join(source, entry.name);
    const targetPath = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(sourcePath, targetPath, missingMessage);
    else if (entry.isFile()) copyFileSync(sourcePath, targetPath);
  }
}

function emitRuntimeDeclarations(): void {
  const typesRoot = path.join(runtimeRoot, "types");
  rmSync(typesRoot, { recursive: true, force: true });
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
          types: ["bun", "node"],
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
    run(process.execPath, ["x", "tsc", "--project", tsconfigPath]);
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
