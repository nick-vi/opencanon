import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  OpenCanonError,
  createOpenCanonDiagnostic,
  resolveRootDir,
  writeAtomicBinaryFileSync,
  type OpenCanonDiagnostic,
} from "@opencanon/core";
import { engineBindingName } from "@opencanon/engine";
import { daemonSchemaVersion, requiredBunVersion } from "./runtime.ts";
import { inspectProjectDaemon } from "./supervisor.ts";

const RuntimeManifestVersion = 1;
const Sha256Pattern = /^[a-f0-9]{64}$/i;
const RuntimeChannelPattern = /^[a-z][a-z0-9._-]*$/u;
const MaxRuntimeFetchRedirects = 5;

const EngineArch = {
  Arm64: "arm64",
  X64: "x64",
} as const;

const EnginePlatformName = {
  Darwin: "darwin",
  Linux: "linux",
  Win32: "win32",
} as const;

const UrlProtocol = {
  File: "file:",
  Http: "http:",
  Https: "https:",
} as const;

const EngineTarget = {
  DarwinArm64: "darwin-arm64",
  DarwinX64: "darwin-x64",
  LinuxArm64: "linux-arm64",
  LinuxX64: "linux-x64",
  Win32X64: "win32-x64",
} as const;
export type EngineTarget = (typeof EngineTarget)[keyof typeof EngineTarget];

const engineTargetPlatforms: Record<EngineTarget, { platform: NodeJS.Platform; arch: NodeJS.Architecture }> = {
  [EngineTarget.DarwinArm64]: { platform: EnginePlatformName.Darwin, arch: EngineArch.Arm64 },
  [EngineTarget.DarwinX64]: { platform: EnginePlatformName.Darwin, arch: EngineArch.X64 },
  [EngineTarget.LinuxArm64]: { platform: EnginePlatformName.Linux, arch: EngineArch.Arm64 },
  [EngineTarget.LinuxX64]: { platform: EnginePlatformName.Linux, arch: EngineArch.X64 },
  [EngineTarget.Win32X64]: { platform: EnginePlatformName.Win32, arch: EngineArch.X64 },
};

const RuntimeUpdateDiagnosticCode = {
  Failed: "runtime-update-failed",
  InvalidManifest: "runtime-manifest-invalid",
} as const;

const RuntimeArchiveFormat = {
  TarGz: "tar.gz",
} as const;
type RuntimeArchiveFormat = (typeof RuntimeArchiveFormat)[keyof typeof RuntimeArchiveFormat];

const RuntimeUpdateStatus = {
  Current: "current",
  Missing: "missing",
  UpdateAvailable: "update-available",
  DryRun: "dry-run",
  Installed: "installed",
} as const;
export type RuntimeUpdateStatus = (typeof RuntimeUpdateStatus)[keyof typeof RuntimeUpdateStatus];

export type RuntimeManifestAsset = {
  url: string;
  sha256: string;
  schemaVersion: number;
};

export type RuntimeArchiveAsset = {
  url: string;
  sha256: string;
  format: RuntimeArchiveFormat;
};

export type RuntimeManifest = {
  version: 1;
  channel: string;
  skillVersion: string;
  requiredBun: string;
  daemonSchema: number;
  runtime?: RuntimeArchiveAsset;
  engine: Partial<Record<EngineTarget, RuntimeManifestAsset>>;
};

export type RuntimeUpdateCheck = {
  status: Extract<RuntimeUpdateStatus, "current" | "missing" | "update-available">;
  manifestSource: string;
  channel: string;
  skillVersion: string;
  requiredBun: string;
  daemonSchema: number;
  target: EngineTarget;
  assetUrl: string;
  resolvedAssetSource: string;
  runtimePath: string;
  expectedSha256: string;
  currentSha256?: string;
  engineSchema: number;
  runtimeArchiveUrl?: string;
  resolvedRuntimeArchiveSource?: string;
  runtimeArchiveSha256?: string;
};

export type RuntimeUpdateApplyResult = {
  status: Extract<RuntimeUpdateStatus, "current" | "dry-run" | "installed">;
  check: RuntimeUpdateCheck;
};

type RuntimeManifestSource = {
  input: string;
  text: string;
  baseDir?: string;
  baseUrl?: URL;
};

type RuntimeManifestLoad = RuntimeManifestSource & {
  manifest: RuntimeManifest;
};

const defaultRuntimeRoot = fileURLToPath(new URL(".", import.meta.url));

export function currentEngineTarget(platform: NodeJS.Platform = process.platform, arch: NodeJS.Architecture = process.arch): EngineTarget {
  const target = `${platform}-${arch}`;
  if (isEngineTarget(target)) return target;
  throw new OpenCanonError([
    createOpenCanonDiagnostic({
      code: "engine-binary-missing",
      message: `Unsupported engine platform: ${target}.`,
      details: [`Supported platforms: ${Object.values(EngineTarget).join(", ")}.`],
    }),
  ]);
}

export function engineRuntimePathForTarget(runtimeRoot: string, target = currentEngineTarget()): string {
  const platform = engineTargetPlatforms[target];
  return path.join(runtimeRoot, "engine", target, engineBindingName("opencanon", platform.platform, platform.arch));
}

export async function checkRuntimeUpdate(input: { manifestSource: string; cwd?: string; runtimeRoot?: string }): Promise<RuntimeUpdateCheck> {
  const runtimeRoot = input.runtimeRoot ?? defaultRuntimeRoot;
  const loaded = await loadRuntimeManifest(input.manifestSource, input.cwd ?? process.cwd());
  const target = currentEngineTarget();
  const asset = loaded.manifest.engine[target];
  if (!asset) {
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: "engine-binary-missing",
        message: `Runtime manifest has no engine asset for ${target}.`,
        details: [`Manifest source: ${input.manifestSource}`, `Available targets: ${Object.keys(loaded.manifest.engine).join(", ") || "<none>"}.`],
      }),
    ]);
  }
  validateRuntimeCompatibility(loaded.manifest, asset);

  const runtimePath = engineRuntimePathForTarget(runtimeRoot, target);
  const currentSha256 = existsSync(runtimePath) ? sha256File(runtimePath) : undefined;
  const status = currentSha256 === undefined ? RuntimeUpdateStatus.Missing : currentSha256 === asset.sha256 ? RuntimeUpdateStatus.Current : RuntimeUpdateStatus.UpdateAvailable;

  return {
    status,
    manifestSource: loaded.input,
    channel: loaded.manifest.channel,
    skillVersion: loaded.manifest.skillVersion,
    requiredBun: loaded.manifest.requiredBun,
    daemonSchema: loaded.manifest.daemonSchema,
    target,
    assetUrl: asset.url,
    resolvedAssetSource: resolveAssetSource(asset.url, loaded),
    runtimePath,
    expectedSha256: asset.sha256,
    currentSha256,
    engineSchema: asset.schemaVersion,
    runtimeArchiveUrl: loaded.manifest.runtime?.url,
    resolvedRuntimeArchiveSource: loaded.manifest.runtime ? resolveAssetSource(loaded.manifest.runtime.url, loaded) : undefined,
    runtimeArchiveSha256: loaded.manifest.runtime?.sha256,
  };
}

export async function applyRuntimeUpdate(input: {
  manifestSource: string;
  cwd?: string;
  rootDir?: string;
  runtimeRoot?: string;
  dryRun?: boolean;
}): Promise<RuntimeUpdateApplyResult> {
  const rootDir = resolveRootDir(input.rootDir ?? input.cwd ?? process.cwd());
  if (!input.dryRun) await assertNoRunningDaemon(rootDir);

  const check = await checkRuntimeUpdate(input);
  if (check.status === RuntimeUpdateStatus.Current) return { status: RuntimeUpdateStatus.Current, check };
  if (input.dryRun) return { status: RuntimeUpdateStatus.DryRun, check };

  const bytes = await readBytes(check.resolvedAssetSource, input.cwd ?? process.cwd());
  const downloadedSha256 = sha256Bytes(bytes);
  if (downloadedSha256 !== check.expectedSha256) {
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: RuntimeUpdateDiagnosticCode.Failed,
        message: "Downloaded OpenCanon engine runtime did not match the manifest checksum.",
        details: [`Expected ${check.expectedSha256}; downloaded ${downloadedSha256}.`, `Asset: ${check.resolvedAssetSource}`],
        action: "Do not run this binary. Retry with a trusted manifest source.",
      }),
    ]);
  }

  writeAtomicBinaryFileSync(check.runtimePath, bytes);
  const installedSha256 = sha256File(check.runtimePath);
  if (installedSha256 !== check.expectedSha256) {
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: RuntimeUpdateDiagnosticCode.Failed,
        message: "Installed OpenCanon engine runtime checksum did not match the manifest.",
        details: [`Expected ${check.expectedSha256}; installed ${installedSha256}.`, `Path: ${check.runtimePath}`],
      }),
    ]);
  }

  return { status: RuntimeUpdateStatus.Installed, check: { ...check, currentSha256: installedSha256, status: RuntimeUpdateStatus.Current } };
}

async function loadRuntimeManifest(source: string, cwd: string): Promise<RuntimeManifestLoad> {
  const manifestSource = await readTextSource(source, cwd);
  const manifest = parseRuntimeManifest(manifestSource.text, manifestSource.input);
  return { ...manifestSource, manifest };
}

function parseRuntimeManifest(text: string, source: string): RuntimeManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw invalidManifest(source, [error instanceof Error ? error.message : String(error)]);
  }

  const diagnostics: string[] = [];
  if (!isRecord(parsed)) throw invalidManifest(source, ["Manifest root must be an object."]);
  if (parsed.version !== RuntimeManifestVersion) diagnostics.push(`version must be ${RuntimeManifestVersion}.`);
  const channel = typeof parsed.channel === "string" && parsed.channel.length > 0 ? parsed.channel : "stable";
  if (!RuntimeChannelPattern.test(channel) || channel === "latest") diagnostics.push("channel must match [a-z][a-z0-9._-]* and cannot be latest.");
  if (typeof parsed.skillVersion !== "string" || parsed.skillVersion.length === 0) diagnostics.push("skillVersion must be a non-empty string.");
  if (typeof parsed.requiredBun !== "string" || parsed.requiredBun.length === 0) diagnostics.push("requiredBun must be a non-empty string.");
  if (!Number.isInteger(parsed.daemonSchema) || Number(parsed.daemonSchema) < 1) diagnostics.push("daemonSchema must be a positive integer.");
  if (!isRecord(parsed.engine)) diagnostics.push("engine must be an object keyed by target.");

  const runtime = parseRuntimeArchiveAsset(parsed.runtime, diagnostics);
  const engine: Partial<Record<EngineTarget, RuntimeManifestAsset>> = {};
  if (isRecord(parsed.engine)) {
    for (const [target, asset] of Object.entries(parsed.engine)) {
      if (!isEngineTarget(target)) {
        diagnostics.push(`engine.${target} is not a supported target.`);
        continue;
      }
      if (!isRecord(asset)) {
        diagnostics.push(`engine.${target} must be an object.`);
        continue;
      }
      const url = asset.url;
      const sha256 = asset.sha256;
      const schemaVersion = asset.schemaVersion;
      if (typeof url !== "string" || url.length === 0) diagnostics.push(`engine.${target}.url must be a non-empty string.`);
      if (typeof sha256 !== "string" || !Sha256Pattern.test(sha256)) diagnostics.push(`engine.${target}.sha256 must be a 64-character SHA-256 hex string.`);
      if (!Number.isInteger(schemaVersion) || Number(schemaVersion) < 1) diagnostics.push(`engine.${target}.schemaVersion must be a positive integer.`);
      if (typeof url === "string" && typeof sha256 === "string" && Sha256Pattern.test(sha256) && Number.isInteger(schemaVersion) && Number(schemaVersion) >= 1) {
        engine[target] = {
          url,
          sha256: sha256.toLowerCase(),
          schemaVersion: Number(schemaVersion),
        };
      }
    }
  }

  if (diagnostics.length > 0) throw invalidManifest(source, diagnostics);
  return {
    version: RuntimeManifestVersion,
    channel,
    skillVersion: parsed.skillVersion as string,
    requiredBun: parsed.requiredBun as string,
    daemonSchema: parsed.daemonSchema as number,
    ...(runtime ? { runtime } : {}),
    engine,
  };
}

function parseRuntimeArchiveAsset(value: unknown, diagnostics: string[]): RuntimeArchiveAsset | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    diagnostics.push("runtime must be an object when provided.");
    return undefined;
  }
  const url = value.url;
  const sha256 = value.sha256;
  const format = value.format;
  if (typeof url !== "string" || url.length === 0) diagnostics.push("runtime.url must be a non-empty string.");
  if (typeof sha256 !== "string" || !Sha256Pattern.test(sha256)) diagnostics.push("runtime.sha256 must be a 64-character SHA-256 hex string.");
  if (format !== RuntimeArchiveFormat.TarGz) diagnostics.push(`runtime.format must be ${RuntimeArchiveFormat.TarGz}.`);
  if (typeof url === "string" && typeof sha256 === "string" && Sha256Pattern.test(sha256) && format === RuntimeArchiveFormat.TarGz) {
    return { url, sha256: sha256.toLowerCase(), format };
  }
  return undefined;
}

function validateRuntimeCompatibility(manifest: RuntimeManifest, asset: RuntimeManifestAsset): void {
  const diagnostics: OpenCanonDiagnostic[] = [];
  if (manifest.requiredBun !== requiredBunVersion) {
    diagnostics.push(
      createOpenCanonDiagnostic({
        code: RuntimeUpdateDiagnosticCode.Failed,
        message: "Runtime manifest targets a different Bun version.",
        details: [`Manifest requires ${manifest.requiredBun}; current runtime requires ${requiredBunVersion}.`],
      }),
    );
  }
  if (manifest.daemonSchema !== daemonSchemaVersion) {
    diagnostics.push(
      createOpenCanonDiagnostic({
        code: RuntimeUpdateDiagnosticCode.Failed,
        message: "Runtime manifest targets a different daemon schema.",
        details: [`Manifest schema ${manifest.daemonSchema}; current schema ${daemonSchemaVersion}.`],
      }),
    );
  }
  if (asset.schemaVersion !== daemonSchemaVersion) {
    diagnostics.push(
      createOpenCanonDiagnostic({
        code: RuntimeUpdateDiagnosticCode.Failed,
        message: "Engine runtime asset targets a different schema.",
        details: [`Asset schema ${asset.schemaVersion}; current daemon schema ${daemonSchemaVersion}.`],
      }),
    );
  }
  if (diagnostics.length > 0) throw new OpenCanonError(diagnostics);
}

async function assertNoRunningDaemon(rootDir: string): Promise<void> {
  const inspection = await inspectProjectDaemon(rootDir);
  if (!inspection || inspection.status === "stale") return;
  throw new OpenCanonError([
    createOpenCanonDiagnostic({
      code: RuntimeUpdateDiagnosticCode.Failed,
      message: "OpenCanon runtime update requires the project daemon to be stopped.",
      details: [`Daemon status: ${inspection.status}.`, `Root: ${rootDir}`],
      action: "Run bun run opencanon daemon stop, then rerun the update.",
    }),
  ]);
}

async function readTextSource(source: string, cwd: string): Promise<RuntimeManifestSource> {
  const parsed = parseAbsoluteUrl(source);
  if (parsed?.protocol === UrlProtocol.Http || parsed?.protocol === UrlProtocol.Https) {
    const response = await fetchTrusted(parsed, "runtime manifest");
    if (!response.ok) throw updateFailed(`Could not read runtime manifest: ${response.status} ${response.statusText}.`, source);
    return { input: source, text: await response.text(), baseUrl: parsed };
  }
  const filePath = parsed?.protocol === UrlProtocol.File ? fileURLToPath(parsed) : path.resolve(cwd, source);
  return { input: source, text: readFileSync(filePath, "utf8"), baseDir: path.dirname(filePath) };
}

async function readBytes(source: string, cwd: string): Promise<Buffer> {
  const parsed = parseAbsoluteUrl(source);
  if (parsed?.protocol === UrlProtocol.Http || parsed?.protocol === UrlProtocol.Https) {
    const response = await fetchTrusted(parsed, "runtime asset");
    if (!response.ok) throw updateFailed(`Could not download runtime asset: ${response.status} ${response.statusText}.`, source);
    return Buffer.from(await response.arrayBuffer());
  }
  const filePath = parsed?.protocol === UrlProtocol.File ? fileURLToPath(parsed) : path.resolve(cwd, source);
  return readFileSync(filePath);
}

function fetchOptions(): RequestInit {
  return { headers: new Headers({ "User-Agent": "opencanon-runtime-update" }), redirect: "manual" };
}

async function fetchTrusted(url: URL, label: string, redirectCount = 0): Promise<Response> {
  assertTrustedFetchUrl(url, label);
  const response = await fetch(url, fetchOptions());
  const redirectedTo = redirectTarget(response, url);
  if (!redirectedTo) {
    assertTrustedFetchUrl(new URL(response.url || url.href), label);
    return response;
  }
  if (redirectCount >= MaxRuntimeFetchRedirects) throw updateFailed(`Too many redirects while reading ${label}.`, url.href);
  return fetchTrusted(redirectedTo, label, redirectCount + 1);
}

function redirectTarget(response: Response, url: URL): URL | undefined {
  if (![301, 302, 303, 307, 308].includes(response.status)) return undefined;
  const location = response.headers.get("location");
  return location ? new URL(location, url) : undefined;
}

function assertTrustedFetchUrl(url: URL, label: string): void {
  if (url.protocol === UrlProtocol.Https) return;
  throw updateFailed(`Refusing to read ${label} over insecure HTTP. Use HTTPS, file:, or a local path.`, url.href);
}

function resolveAssetSource(assetUrl: string, manifest: RuntimeManifestSource): string {
  const parsed = parseAbsoluteUrl(assetUrl);
  if (parsed) return parsed.href;
  if (manifest.baseUrl) return new URL(assetUrl, manifest.baseUrl).href;
  if (manifest.baseDir) return path.resolve(manifest.baseDir, assetUrl);
  return assetUrl;
}

function parseAbsoluteUrl(source: string): URL | undefined {
  try {
    const parsed = new URL(source);
    return parsed.protocol ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sha256File(filePath: string): string {
  return sha256Bytes(readFileSync(filePath));
}

function sha256Bytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function invalidManifest(source: string, details: string[]): OpenCanonError {
  return new OpenCanonError([
    createOpenCanonDiagnostic({
      code: RuntimeUpdateDiagnosticCode.InvalidManifest,
      message: "OpenCanon runtime manifest is invalid.",
      details: [`Source: ${source}`, ...details],
    }),
  ]);
}

function updateFailed(message: string, source: string): OpenCanonError {
  return new OpenCanonError([
    createOpenCanonDiagnostic({
      code: RuntimeUpdateDiagnosticCode.Failed,
      message,
      details: [`Source: ${source}`],
    }),
  ]);
}

function isEngineTarget(value: string): value is EngineTarget {
  return Object.values(EngineTarget).includes(value as EngineTarget);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
