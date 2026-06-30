import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create as tarCreate } from "tar";
import { requiredNodeRequirement } from "../packages/distribution/src/node.ts";
import { trustedReleaseKeys } from "../packages/core/src/release-keys.ts";
import { signManifestText } from "./release-signing.ts";
import {
  engineBindingName,
  type EngineArch,
  type EnginePlatform,
} from "../packages/engine/src/index.ts";

const rootDir = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const ManifestFileName = "opencanon-runtime-manifest.json";
const InstallerFileName = "opencanon-install.mjs";
const LatestFileName = "latest.json";
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
  requireSignature?: boolean;
  runtimeDir?: string;
  runtimeVersion?: string;
};

export type CreateOpenCanonReleaseResult = {
  assetDir: string;
  bundlePaths: Partial<Record<EngineTarget, string>>;
  channel: string;
  checksumPath: string;
  installerPath: string;
  latestPath: string;
  manifestPath: string;
  missingTargets: EngineTarget[];
  outDir: string;
  runtimeVersion: string;
  targets: EngineTarget[];
};

type RuntimeBundleAsset = {
  url: string;
  sha256: string;
};

type RuntimeManifest = {
  version: 1;
  channel: string;
  runtimeVersion: string;
  requiredNode: string;
  bundles: Partial<Record<EngineTarget, RuntimeBundleAsset>>;
};

type CliOptions = Required<
  Pick<CreateOpenCanonReleaseInput, "clean" | "requireAll" | "requireRuntime">
> &
  Omit<CreateOpenCanonReleaseInput, "clean" | "requireAll" | "requireRuntime">;

export function createOpenCanonRelease(
  input: CreateOpenCanonReleaseInput = {},
): CreateOpenCanonReleaseResult {
  const assetDir = path.resolve(rootDir, input.assetDir ?? "packages/engine/binaries");
  const outDir = path.resolve(rootDir, input.outDir ?? "dist/opencanon-release");
  const channel = input.channel ?? "stable";
  if (!ChannelNamePattern.test(channel) || channel === "latest") {
    throw new Error("Release channel must match [a-z][a-z0-9._-]* and cannot be latest.");
  }
  const runtimeVersion = input.runtimeVersion ?? defaultRuntimeVersion();
  const runtimeDir = resolveRuntimeDir(input.runtimeDir);

  if (input.clean) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  if (!existsSync(runtimeDir)) {
    if (input.requireRuntime) throw new Error(`Missing generated OpenCanon runtime ${runtimeDir}. Run npm run build:runtime first.`);
    throw new Error(`Generated OpenCanon runtime ${runtimeDir} is required to assemble bundles. Run npm run build:runtime first.`);
  }

  const bundles: RuntimeManifest["bundles"] = {};
  const bundlePaths: Partial<Record<EngineTarget, string>> = {};
  const checksums: Array<{ fileName: string; sha256: string }> = [];
  const missingTargets: EngineTarget[] = [];

  for (const target of targetDefinitions) {
    const fileName = engineBindingName("opencanon", target.platform, target.arch);
    const source = engineAssetPath(assetDir, target.target, fileName);
    if (!source) {
      missingTargets.push(target.target);
      continue;
    }
    const bundleFileName = `opencanon-runtime-${target.target}.tar.gz`;
    const bundlePath = path.join(outDir, bundleFileName);
    packageBundle({ outputPath: bundlePath, runtimeDir, target: target.target, engineFileName: fileName, engineSource: source });
    const sha256 = sha256File(bundlePath);
    checksums.push({ fileName: bundleFileName, sha256 });
    bundles[target.target] = { url: assetUrl(input.assetBaseUrl, bundleFileName), sha256 };
    bundlePaths[target.target] = bundlePath;
  }

  if (input.requireAll && missingTargets.length > 0) {
    throw new Error(`Missing engine release assets for: ${missingTargets.join(", ")}.`);
  }
  if (Object.keys(bundles).length === 0) {
    throw new Error(`No engine release assets found in ${assetDir}. Run npm run build:engine first.`);
  }
  const manifest: RuntimeManifest = {
    version: 1,
    channel,
    runtimeVersion,
    requiredNode: requiredNodeRequirement,
    bundles,
  };
  const manifestPath = path.join(outDir, ManifestFileName);
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;
  writeFileSync(manifestPath, manifestText);
  const latestPath = path.join(outDir, LatestFileName);
  writeFileSync(latestPath, manifestText);
  const channelPath = path.join(outDir, `${channel}.json`);
  writeFileSync(channelPath, manifestText);
  checksums.push({ fileName: ManifestFileName, sha256: sha256File(manifestPath) });
  checksums.push({ fileName: LatestFileName, sha256: sha256File(latestPath) });
  checksums.push({ fileName: `${channel}.json`, sha256: sha256File(channelPath) });

  // Sign the manifest bytes (all three files are byte-identical, so one signature serves
  // all). The detached sidecars are what remote clients verify against the baked-in
  // trusted keys. `--require-signature` makes a missing key a hard error for real
  // releases; local/CI manifest generation stays unsigned (consumed via file: paths,
  // which are exempt from the signature requirement).
  const privateKeyPem = process.env.OPENCANON_RELEASE_PRIVATE_KEY;
  if (input.requireSignature && !privateKeyPem) {
    throw new Error("OPENCANON_RELEASE_PRIVATE_KEY is required to sign the release manifest (--require-signature).");
  }
  if (input.requireSignature && trustedReleaseKeys.length === 0) {
    throw new Error("packages/core/src/release-keys.ts must include a trusted public release key before signing a remote release.");
  }
  if (privateKeyPem) {
    const sidecarText = `${JSON.stringify(signManifestText(manifestText, privateKeyPem), null, 2)}\n`;
    for (const fileName of [ManifestFileName, LatestFileName, `${channel}.json`]) {
      const sigPath = path.join(outDir, `${fileName}.sig`);
      writeFileSync(sigPath, sidecarText);
      checksums.push({ fileName: `${fileName}.sig`, sha256: sha256File(sigPath) });
    }
  }

  const checksumPath = path.join(outDir, ChecksumFileName);
  const installerPath = path.join(outDir, InstallerFileName);
  writeFileSync(installerPath, renderInstallerAsset());
  chmodSync(installerPath, 0o755);
  checksums.push({ fileName: InstallerFileName, sha256: sha256File(installerPath) });
  writeFileSync(
    checksumPath,
    checksums.map((entry) => `${entry.sha256}  ${entry.fileName}`).join("\n") + "\n",
  );

  return {
    assetDir,
    bundlePaths,
    channel,
    checksumPath,
    installerPath,
    latestPath,
    manifestPath,
    missingTargets,
    outDir,
    runtimeVersion,
    targets: Object.keys(bundles) as EngineTarget[],
  };
}

function renderInstallerAsset(): string {
  const template = readFileSync(path.join(rootDir, "scripts", InstallerFileName), "utf8");
  const marker = "/* OPENCANON_TRUSTED_RELEASE_KEYS */ []";
  if (!template.includes(marker)) {
    throw new Error(`${InstallerFileName} is missing the trusted release key injection marker.`);
  }
  return template.replace(marker, JSON.stringify(trustedReleaseKeys, null, 2));
}

function resolveRuntimeDir(runtimeDir?: string): string {
  if (runtimeDir) return path.resolve(rootDir, runtimeDir);
  const explicit = process.env.OPENCANON_BUILD_RUNTIME_DIR;
  if (explicit) return path.resolve(rootDir, explicit);
  return path.resolve(rootDir, "tmp/opencanon-runtime");
}

function packageBundle(input: {
  outputPath: string;
  runtimeDir: string;
  target: EngineTarget;
  engineFileName: string;
  engineSource: string;
}): void {
  const stagingDir = mkdtempSync(path.join(tmpdir(), "opencanon-bundle-"));
  try {
    // Bundle layout matches the installed runtime tree: cli.js + validators.js + engine/<target>/<binding>.node, plus everything else under the runtime except foreign engine binaries.
    copyTree(input.runtimeDir, stagingDir, (relPath) => {
      if (relPath === "engine" || relPath.startsWith(`engine${path.sep}`) || relPath.startsWith("engine/")) return false;
      return true;
    });
    const engineTargetDir = path.join(stagingDir, "engine", input.target);
    mkdirSync(engineTargetDir, { recursive: true });
    copyFileSync(input.engineSource, path.join(engineTargetDir, input.engineFileName));
    // Deterministic, reproducible archive: a sorted file list + portable/noMtime headers so
    // the same tag always yields identical bytes (and thus a stable signed sha256). Built
    // with node-tar (pure JS) rather than the system `tar`, whose GNU/bsd flags differ and
    // whose gzip embeds build mtime/OS bytes.
    const entries = readdirSync(stagingDir, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => path.relative(stagingDir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
      .sort();
    tarCreate({ file: input.outputPath, cwd: stagingDir, gzip: true, portable: true, noMtime: true, sync: true }, entries);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

function copyTree(source: string, destination: string, filter: (relPath: string) => boolean, currentRel = ""): void {
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    const childSource = path.join(source, entry.name);
    const childRel = currentRel ? path.join(currentRel, entry.name) : entry.name;
    if (!filter(childRel)) continue;
    const childDest = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      mkdirSync(childDest, { recursive: true });
      copyTree(childSource, childDest, filter, childRel);
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      // Symlinks are dereferenced (copyFileSync follows them) so the release tree never
      // ships link entries — consistent with the bundle's no-link policy.
      copyFileSync(childSource, childDest);
    }
  }
}

function engineAssetPath(assetDir: string, target: EngineTarget, fileName: string): string | undefined {
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

function defaultRuntimeVersion(): string {
  const githubRef = process.env.GITHUB_REF_NAME?.trim();
  if (githubRef) return githubRef;
  const result = spawnSync("git", ["describe", "--tags", "--always", "--dirty"], { cwd: rootDir, encoding: "utf8" });
  if (result.status === 0 && result.stdout.trim()) return result.stdout.trim();
  return "0.1.0-dev";
}

function parseCliOptions(args: string[]): CliOptions {
  const options: CliOptions = { clean: false, requireAll: false, requireRuntime: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--asset-base-url") options.assetBaseUrl = requiredValue(args, ++index, arg);
    else if (arg === "--asset-dir") options.assetDir = requiredValue(args, ++index, arg);
    else if (arg === "--channel") options.channel = requiredValue(args, ++index, arg);
    else if (arg === "--clean") options.clean = true;
    else if (arg === "--out-dir") options.outDir = requiredValue(args, ++index, arg);
    else if (arg === "--require-all") options.requireAll = true;
    else if (arg === "--require-runtime") options.requireRuntime = true;
    else if (arg === "--require-signature") options.requireSignature = true;
    else if (arg === "--runtime-dir") options.runtimeDir = requiredValue(args, ++index, arg);
    else if (arg === "--runtime-version") options.runtimeVersion = requiredValue(args, ++index, arg);
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
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
  return value;
}

function printHelp(): void {
  console.log(`Usage:
  node scripts/create-opencanon-release.ts [options]

Options:
  --asset-dir <dir>        Directory containing engine .node files. Default: packages/engine/binaries.
  --out-dir <dir>          Release output directory. Default: dist/opencanon-release.
  --asset-base-url <url>   Base URL or path for manifest bundle URLs. Default: colocated relative files.
  --channel <name>         Release channel. Default: stable.
  --runtime-version <value> Version written to the manifest. Default: current tag/commit.
  --runtime-dir <dir>       Generated OpenCanon runtime directory. Default: tmp/opencanon-runtime.
  --require-all            Fail unless every supported target is present.
  --require-runtime        Fail unless the generated OpenCanon runtime is present.
  --require-signature      Fail unless OPENCANON_RELEASE_PRIVATE_KEY is set to sign the manifest.
  --clean                  Remove out-dir before writing.
`);
}

if (import.meta.main) {
  try {
    const result = createOpenCanonRelease(parseCliOptions(process.argv.slice(2)));
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
