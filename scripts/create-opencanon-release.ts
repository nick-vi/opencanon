import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  daemonSchemaVersion,
  requiredBunVersion,
} from "../packages/daemon/src/runtime.ts";
import {
  engineBindingName,
  type EngineArch,
  type EnginePlatform,
} from "../packages/engine/src/index.ts";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ManifestFileName = "opencanon-runtime-manifest.json";
const LatestFileName = "latest.json";
const RuntimeArchiveFileName = "opencanon-skill-runtime.tar.gz";
const ChecksumFileName = "SHA256SUMS";
const ChannelNamePattern = /^[a-z][a-z0-9._-]*$/u;

const EngineTarget = {
  DarwinArm64: "darwin-arm64",
  DarwinX64: "darwin-x64",
  LinuxArm64: "linux-arm64",
  LinuxX64: "linux-x64",
  Win32X64: "win32-x64",
} as const;
type EngineTarget = (typeof EngineTarget)[keyof typeof EngineTarget];

const targetDefinitions: Array<{
  target: EngineTarget;
  platform: EnginePlatform;
  arch: EngineArch;
}> = [
  { target: EngineTarget.DarwinArm64, platform: "darwin", arch: "arm64" },
  { target: EngineTarget.DarwinX64, platform: "darwin", arch: "x64" },
  { target: EngineTarget.LinuxArm64, platform: "linux", arch: "arm64" },
  { target: EngineTarget.LinuxX64, platform: "linux", arch: "x64" },
  { target: EngineTarget.Win32X64, platform: "win32", arch: "x64" },
];

export type CreateOpenCanonReleaseInput = {
  assetBaseUrl?: string;
  assetDir?: string;
  channel?: string;
  clean?: boolean;
  outDir?: string;
  requireAll?: boolean;
  requireRuntime?: boolean;
  runtimeDir?: string;
  skillVersion?: string;
};

export type CreateOpenCanonReleaseResult = {
  assetDir: string;
  channel: string;
  checksumPath: string;
  latestPath: string;
  manifestPath: string;
  missingTargets: EngineTarget[];
  outDir: string;
  runtimeArchivePath?: string;
  skillVersion: string;
  targets: EngineTarget[];
};

type RuntimeManifestAsset = {
  url: string;
  sha256: string;
  schemaVersion: number;
};

type RuntimeArchiveAsset = {
  url: string;
  sha256: string;
  format: "tar.gz";
};

type RuntimeManifest = {
  version: 1;
  channel: string;
  skillVersion: string;
  requiredBun: string;
  daemonSchema: number;
  runtime?: RuntimeArchiveAsset;
  engine: Partial<Record<EngineTarget, RuntimeManifestAsset>>;
};

type CliOptions = Required<
  Pick<CreateOpenCanonReleaseInput, "clean" | "requireAll" | "requireRuntime">
> &
  Omit<CreateOpenCanonReleaseInput, "clean" | "requireAll" | "requireRuntime">;

export function createOpenCanonRelease(
  input: CreateOpenCanonReleaseInput = {},
): CreateOpenCanonReleaseResult {
  const assetDir = path.resolve(
    rootDir,
    input.assetDir ?? "packages/engine/binaries",
  );
  const outDir = path.resolve(
    rootDir,
    input.outDir ?? "dist/opencanon-release",
  );
  const channel = input.channel ?? "stable";
  if (!ChannelNamePattern.test(channel) || channel === "latest") {
    throw new Error("Release channel must match [a-z][a-z0-9._-]* and cannot be latest.");
  }
  const skillVersion = input.skillVersion ?? defaultSkillVersion();

  if (input.clean) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const engine: RuntimeManifest["engine"] = {};
  const checksums: Array<{ fileName: string; sha256: string }> = [];
  const missingTargets: EngineTarget[] = [];
  const runtimeArchive = packageRuntimeArchive({
    assetBaseUrl: input.assetBaseUrl,
    checksums,
    outDir,
    requireRuntime: Boolean(input.requireRuntime),
    runtimeDir: path.resolve(rootDir, input.runtimeDir ?? ".agents/skills/opencanon/runtime"),
  });

  for (const target of targetDefinitions) {
    const fileName = engineBindingName(
      "opencanon",
      target.platform,
      target.arch,
    );
    const source = engineAssetPath(assetDir, target.target, fileName);
    if (!source) {
      missingTargets.push(target.target);
      continue;
    }

    const outputPath = path.join(outDir, fileName);
    if (path.resolve(source) !== path.resolve(outputPath))
      copyFileSync(source, outputPath);
    const sha256 = sha256File(outputPath);
    checksums.push({ fileName, sha256 });
    engine[target.target] = {
      url: assetUrl(input.assetBaseUrl, fileName),
      sha256,
      schemaVersion: daemonSchemaVersion,
    };
  }

  if (input.requireAll && missingTargets.length > 0) {
    throw new Error(
      `Missing engine release assets for: ${missingTargets.join(", ")}.`,
    );
  }
  if (Object.keys(engine).length === 0) {
    throw new Error(
      `No engine release assets found in ${assetDir}. Run bun run build:engine first.`,
    );
  }

  const manifest: RuntimeManifest = {
    version: 1,
    channel,
    skillVersion,
    requiredBun: requiredBunVersion,
    daemonSchema: daemonSchemaVersion,
    ...(runtimeArchive.asset ? { runtime: runtimeArchive.asset } : {}),
    engine,
  };
  const manifestPath = path.join(outDir, ManifestFileName);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestText);
  const latestPath = path.join(outDir, LatestFileName);
  writeFileSync(latestPath, manifestText);
  const channelPath = path.join(outDir, `${channel}.json`);
  writeFileSync(channelPath, manifestText);
  checksums.push({
    fileName: ManifestFileName,
    sha256: sha256File(manifestPath),
  });
  checksums.push({
    fileName: LatestFileName,
    sha256: sha256File(latestPath),
  });
  checksums.push({
    fileName: `${channel}.json`,
    sha256: sha256File(channelPath),
  });

  const checksumPath = path.join(outDir, ChecksumFileName);
  writeFileSync(
    checksumPath,
    checksums.map((entry) => `${entry.sha256}  ${entry.fileName}`).join("\n") +
      "\n",
  );

  return {
    assetDir,
    channel,
    checksumPath,
    latestPath,
    manifestPath,
    missingTargets,
    outDir,
    runtimeArchivePath: runtimeArchive.path,
    skillVersion,
    targets: Object.keys(engine) as EngineTarget[],
  };
}

function packageRuntimeArchive(input: {
  assetBaseUrl?: string;
  checksums: Array<{ fileName: string; sha256: string }>;
  outDir: string;
  requireRuntime: boolean;
  runtimeDir: string;
}): { asset?: RuntimeArchiveAsset; path?: string } {
  if (!existsSync(input.runtimeDir)) {
    if (input.requireRuntime) throw new Error(`Missing generated skill runtime ${input.runtimeDir}. Run bun run build:skill-runtime first.`);
    return {};
  }

  const outputPath = path.join(input.outDir, RuntimeArchiveFileName);
  run("tar", [
    "--exclude",
    "runtime/engine",
    "-czf",
    outputPath,
    "-C",
    path.dirname(input.runtimeDir),
    path.basename(input.runtimeDir),
  ]);
  const sha256 = sha256File(outputPath);
  input.checksums.push({ fileName: RuntimeArchiveFileName, sha256 });
  return {
    path: outputPath,
    asset: {
      url: assetUrl(input.assetBaseUrl, RuntimeArchiveFileName),
      sha256,
      format: "tar.gz",
    },
  };
}

function engineAssetPath(
  assetDir: string,
  target: EngineTarget,
  fileName: string,
): string | undefined {
  const candidates = [
    path.join(assetDir, fileName),
    path.join(assetDir, target, fileName),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function assetUrl(baseUrl: string | undefined, fileName: string): string {
  if (!baseUrl) return fileName;
  if (baseUrl.startsWith("http://") || baseUrl.startsWith("https://"))
    return new URL(fileName, ensureTrailingSlash(baseUrl)).href;
  return path.posix.join(baseUrl, fileName);
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function sha256File(filePath: string): string {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex");
}

function defaultSkillVersion(): string {
  const githubRef = process.env.GITHUB_REF_NAME?.trim();
  if (githubRef) return githubRef;

  const result = spawnSync(
    "git",
    ["describe", "--tags", "--always", "--dirty"],
    {
      cwd: rootDir,
      encoding: "utf8",
    },
  );
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return "0.1.0-dev";
}

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { clean: false, requireAll: false, requireRuntime: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--asset-base-url")
      options.assetBaseUrl = requiredValue(args, ++index, arg);
    else if (arg === "--asset-dir")
      options.assetDir = requiredValue(args, ++index, arg);
    else if (arg === "--channel")
      options.channel = requiredValue(args, ++index, arg);
    else if (arg === "--clean") options.clean = true;
    else if (arg === "--out-dir")
      options.outDir = requiredValue(args, ++index, arg);
    else if (arg === "--require-all") options.requireAll = true;
    else if (arg === "--require-runtime") options.requireRuntime = true;
    else if (arg === "--runtime-dir")
      options.runtimeDir = requiredValue(args, ++index, arg);
    else if (arg === "--skill-version")
      options.skillVersion = requiredValue(args, ++index, arg);
    else if (arg === "-h" || arg === "--help") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown release option: ${arg}`);
    }
  }
  return options;
}

function requiredValue(args: string[], index: number, flag: string): string {
  const value = args[index];
  if (!value || value.startsWith("--"))
    throw new Error(`${flag} requires a value.`);
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  bun scripts/create-opencanon-release.ts [options]

Options:
  --asset-dir <dir>        Directory containing engine .node files. Default: packages/engine/binaries.
  --out-dir <dir>          Release output directory. Default: dist/opencanon-release.
  --asset-base-url <url>   Base URL or path for manifest asset URLs. Default: colocated relative files.
  --channel <name>         Release channel. Default: stable.
  --skill-version <value>  Version written to the manifest. Default: current tag/commit.
  --runtime-dir <dir>      Generated skill runtime directory. Default: .agents/skills/opencanon/runtime.
  --require-all            Fail unless every supported target is present.
  --require-runtime        Fail unless the generated skill runtime can be archived.
  --clean                  Remove out-dir before writing.
`);
}

if (import.meta.main) {
  try {
    const result = createOpenCanonRelease(parseCliOptions(Bun.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { cwd: rootDir, encoding: "utf8", stdio: "pipe" });
  if (result.status === 0) return;
  const output = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
  throw new Error(output || `Command failed: ${command} ${args.join(" ")}`);
}
