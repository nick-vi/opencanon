import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const RuntimeCliInvocationKind = { NodeScript: "node-script", Executable: "executable" } as const;
export type RuntimeCliInvocationKind = (typeof RuntimeCliInvocationKind)[keyof typeof RuntimeCliInvocationKind];

export type RuntimeCliEntrypoint = {
  path: string;
  kind: RuntimeCliInvocationKind;
  source: string;
};

const EntrypointPlatformName = { Win32: "win32" } as const;

type RuntimeCliInvocation = {
  command: string;
  args: string[];
  entrypoint: RuntimeCliEntrypoint;
};

export function runtimeCliInvocation(rootDir: string, args: string[]): RuntimeCliInvocation {
  const entrypoint = resolveRuntimeCliEntrypoint(rootDir);
  if (entrypoint.kind === RuntimeCliInvocationKind.NodeScript) {
    return { command: nodeCommandForCliInvocation(), args: [entrypoint.path, ...args], entrypoint };
  }
  return { command: entrypoint.path, args: [...args], entrypoint };
}

export function nodeCommandForCliInvocation(): string {
  if (existsSync(process.execPath)) return process.execPath;
  return findExecutablePathOnPath("node") ?? process.execPath;
}

export function resolveRuntimeCliEntrypoint(rootDir: string): RuntimeCliEntrypoint {
  const envOverride = nonEmptyString(process.env.OPENCANON_CLI);
  if (envOverride) {
    const entrypoint = cliEntrypointFromCandidate(envOverride, "env");
    if (entrypoint) return entrypoint;
    throw new Error(`OPENCANON_CLI points at a missing OpenCanon CLI entrypoint: ${envOverride}.`);
  }

  const current = process.argv[1] ? path.resolve(process.argv[1]) : "";
  if (current && isKnownOpenCanonCliPath(current)) {
    const entrypoint = cliEntrypointFromCandidate(current, "current-argv");
    if (entrypoint) return entrypoint;
  }

  const pathEntrypoint = findCommandOnPath("opencanon");
  if (pathEntrypoint) return pathEntrypoint;

  for (const candidate of devCheckoutCliCandidates(rootDir)) {
    const entrypoint = cliEntrypointFromCandidate(candidate, "dev-checkout");
    if (entrypoint) return entrypoint;
  }

  throw new Error(`OpenCanon CLI not found for ${rootDir}. Install the OpenCanon runtime, make opencanon available on PATH, or set OPENCANON_CLI.`);
}

function cliEntrypointFromCandidate(candidate: string, source: string): RuntimeCliEntrypoint | undefined {
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
  const resolved = realpathSync(candidate);
  return {
    path: resolved,
    kind: isNodeScriptCli(resolved) ? RuntimeCliInvocationKind.NodeScript : RuntimeCliInvocationKind.Executable,
    source,
  };
}

function devCheckoutCliCandidates(rootDir: string): string[] {
  return uniqueStrings([rootDir, process.cwd(), path.dirname(fileURLToPath(import.meta.url))]
    .flatMap((start) => ancestorPaths(start))
    .map((candidate) => path.join(candidate, "packages", "cli", "src", "index.ts")));
}

export function ancestorPaths(rootDir: string): string[] {
  const ancestors: string[] = [];
  let current = path.resolve(rootDir);
  while (true) {
    ancestors.push(current);
    const parent = path.dirname(current);
    if (parent === current) return ancestors;
    current = parent;
  }
}

function isKnownOpenCanonCliPath(candidate: string): boolean {
  const normalized = candidate.replace(/\\/g, "/");
  return (
    normalized.endsWith("/packages/cli/src/index.ts") ||
    normalized.endsWith("/node_modules/.bin/opencanon") ||
    isInstalledRuntimeCli(candidate)
  );
}

function isInstalledRuntimeCli(candidate: string): boolean {
  if (path.basename(candidate) !== "cli.js") return false;
  const dir = path.dirname(candidate);
  if (!existsSync(path.join(dir, "runtime.js"))) return false;
  try {
    const packageJson = JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as { name?: string; type?: string };
    return packageJson.name === "opencanon" && packageJson.type === "module";
  } catch {
    return false;
  }
}

export function isNodeScriptCli(candidate: string): boolean {
  const extension = path.extname(candidate).toLowerCase();
  if ([".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)) return true;
  try {
    const firstLine = readFileSync(candidate, "utf8").split(/\r?\n/u, 1)[0] ?? "";
    return firstLine.startsWith("#!") && firstLine.includes("node");
  } catch {
    return false;
  }
}

function findCommandOnPath(command: string): RuntimeCliEntrypoint | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of executableNameCandidates(path.join(dir, command))) {
      const entrypoint = cliEntrypointFromCandidate(candidate, "path");
      if (entrypoint) return entrypoint;
    }
  }
  return undefined;
}

function findExecutablePathOnPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir) continue;
    for (const candidate of executableNameCandidates(path.join(dir, command))) {
      try {
        if (statSync(candidate).isFile()) return realpathSync(candidate);
      } catch {
        // Keep searching PATH entries.
      }
    }
  }
  return undefined;
}

function executableNameCandidates(base: string): string[] {
  if (process.platform !== EntrypointPlatformName.Win32 || path.extname(base)) return [base];
  return [base, `${base}.cmd`, `${base}.ps1`, `${base}.exe`];
}

function uniqueStrings(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = path.resolve(value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function nonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
