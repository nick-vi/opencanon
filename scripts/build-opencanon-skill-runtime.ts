import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
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

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8", stdio: "pipe" });
  if (result.status === 0) return;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(output || `Command failed: ${command} ${args.join(" ")}`);
}
