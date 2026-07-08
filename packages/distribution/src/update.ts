import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OpenCanonError, createOpenCanonDiagnostic, satisfiesMinimumVersion, type OpenCanonDiagnostic } from "@opencanon/core";
import { safeExtract } from "@opencanon/core/safe-extract";
import { isRemoteManifestSource, parseSignatureSidecar, signatureSidecarLocation, verifyManifestForSource, type ManifestSignatureSidecar } from "@opencanon/core/release-manifest";
import { engineBindingName } from "@opencanon/engine";
import { currentNodeVersion, requiredNodeRequirement } from "./node.ts";

const RuntimeManifestVersion = 1;
const Sha256Pattern = /^[a-f0-9]{64}$/i;
const RuntimeChannelPattern = /^[a-z][a-z0-9._-]*$/u;
const MaxRuntimeFetchRedirects = 5;
const BundleMarkerFile = ".bundle.json";

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

// Single source of truth for runtime-update statuses; reference members instead of inlining the strings.
export const RuntimeUpdateStatus = {
  Current: "current",
  Missing: "missing",
  UpdateAvailable: "update-available",
  DryRun: "dry-run",
  Installed: "installed",
} as const;
export type RuntimeUpdateStatus = (typeof RuntimeUpdateStatus)[keyof typeof RuntimeUpdateStatus];

export type RuntimeBundleAsset = {
  url: string;
  sha256: string;
};

export type RuntimeManifest = {
  version: 1;
  channel: string;
  runtimeVersion: string;
  requiredNode: string;
  bundles: Partial<Record<EngineTarget, RuntimeBundleAsset>>;
};

export type RuntimeUpdateCheck = {
  status: Extract<RuntimeUpdateStatus, "current" | "missing" | "update-available">;
  manifestSource: string;
  channel: string;
  runtimeVersion: string;
  requiredNode: string;
  target: EngineTarget;
  bundleUrl: string;
  resolvedBundleSource: string;
  runtimeRoot: string;
  runtimePath: string;
  expectedSha256: string;
  currentSha256?: string;
};

export type RuntimeUpdateProjectAction = {
  id: "refresh-managed-project-artifacts";
  title: string;
  command: "opencanon doctor --fix";
  scope: "initialized-projects";
  reason: string;
};

export type RuntimeUpdateApplyResult = {
  status: Extract<RuntimeUpdateStatus, "current" | "dry-run" | "installed">;
  check: RuntimeUpdateCheck;
  projectActions: RuntimeUpdateProjectAction[];
};

export type UpdateSafetyGuard = {
  assertSafeToUpdate(): Promise<void> | void;
};

type BundleMarker = {
  runtimeVersion?: string;
  sha256: string;
  target: EngineTarget;
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

const RuntimeRootEnv = "OPENCANON_RUNTIME_ROOT";

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
  const runtimeRoot = input.runtimeRoot ?? defaultRuntimeRoot();
  const loaded = await loadRuntimeManifest(input.manifestSource, input.cwd ?? process.cwd());
  const target = currentEngineTarget();
  const bundle = loaded.manifest.bundles[target];
  if (!bundle) {
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: "engine-binary-missing",
        message: `Runtime manifest has no bundle for ${target}.`,
        details: [`Manifest source: ${input.manifestSource}`, `Available targets: ${Object.keys(loaded.manifest.bundles).join(", ") || "<none>"}.`],
      }),
    ]);
  }
  validateRuntimeCompatibility(loaded.manifest);

  const marker = readBundleMarker(runtimeRoot);
  const status =
    !marker
      ? RuntimeUpdateStatus.Missing
      : marker.sha256 === bundle.sha256 && marker.target === target
        ? RuntimeUpdateStatus.Current
        : RuntimeUpdateStatus.UpdateAvailable;

  return {
    status,
    manifestSource: loaded.input,
    channel: loaded.manifest.channel,
    runtimeVersion: loaded.manifest.runtimeVersion,
    requiredNode: loaded.manifest.requiredNode,
    target,
    bundleUrl: bundle.url,
    resolvedBundleSource: resolveAssetSource(bundle.url, loaded),
    runtimeRoot,
    runtimePath: engineRuntimePathForTarget(runtimeRoot, target),
    expectedSha256: bundle.sha256,
    currentSha256: marker?.sha256,
  };
}

function defaultRuntimeRoot(): string {
  const explicit = process.env[RuntimeRootEnv];
  if (explicit?.trim()) return path.resolve(explicit);
  return fileURLToPath(new URL(".", import.meta.url));
}

export async function applyRuntimeUpdate(input: {
  manifestSource: string;
  cwd?: string;
  runtimeRoot?: string;
  dryRun?: boolean;
  safety: UpdateSafetyGuard;
}): Promise<RuntimeUpdateApplyResult> {
  if (!input.dryRun) await input.safety.assertSafeToUpdate();

  const check = await checkRuntimeUpdate(input);
  if (check.status === RuntimeUpdateStatus.Current) return { status: RuntimeUpdateStatus.Current, check, projectActions: [] };

  // Rollback protection: never install an older runtimeVersion over a newer one. The
  // version comes from the signature-verified manifest, so an attacker cannot strip it;
  // this blocks replay of a genuinely-signed OLD manifest to force a downgrade.
  const installed = readBundleMarker(check.runtimeRoot);
  if (installed?.runtimeVersion && !satisfiesMinimumVersion(check.runtimeVersion, installed.runtimeVersion)) {
    throw updateFailed(
      `Refusing to install runtimeVersion ${check.runtimeVersion} over the newer installed ${installed.runtimeVersion} (downgrade).`,
      check.manifestSource,
    );
  }

  if (input.dryRun) return { status: RuntimeUpdateStatus.DryRun, check, projectActions: [] };

  const bytes = await readBytes(check.resolvedBundleSource, input.cwd ?? process.cwd());
  const downloadedSha256 = sha256Bytes(bytes);
  if (downloadedSha256 !== check.expectedSha256) {
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: RuntimeUpdateDiagnosticCode.Failed,
        message: "Downloaded OpenCanon runtime bundle did not match the manifest checksum.",
        details: [`Expected ${check.expectedSha256}; downloaded ${downloadedSha256}.`, `Bundle: ${check.resolvedBundleSource}`],
        action: "Do not run this bundle. Retry with a trusted manifest source.",
      }),
    ]);
  }

  installBundle({
    runtimeRoot: check.runtimeRoot,
    bytes,
    marker: { runtimeVersion: check.runtimeVersion, sha256: check.expectedSha256, target: check.target },
  });

  return {
    status: RuntimeUpdateStatus.Installed,
    check: { ...check, currentSha256: check.expectedSha256, status: RuntimeUpdateStatus.Current },
    projectActions: [runtimeUpdateProjectRefreshAction()],
  };
}

export function runtimeUpdateProjectRefreshAction(): RuntimeUpdateProjectAction {
  return {
    id: "refresh-managed-project-artifacts",
    title: "Refresh managed project artifacts",
    command: "opencanon doctor --fix",
    scope: "initialized-projects",
    reason: "Runtime updates can change managed agent guidance, agent entry blocks, generated authoring files, and install metadata. Doctor is the single repair path for those project-owned artifacts.",
  };
}

// Atomic rename of runtimeRoot can fail on Windows if cli.js inside is mapped by the calling process; invoke from outside the runtime dir on Windows.
function installBundle(input: { runtimeRoot: string; bytes: Buffer; marker: BundleMarker }): void {
  installArchive({ root: input.runtimeRoot, bytes: input.bytes, markerFile: BundleMarkerFile, marker: input.marker, stagingPrefix: ".opencanon-runtime-staging-" });
}

function installArchive(input: { root: string; bytes: Buffer; markerFile: string; marker: unknown; stagingPrefix: string }): void {
  const targetRoot = path.resolve(input.root);
  const stagingParent = path.dirname(targetRoot);
  mkdirSync(stagingParent, { recursive: true });
  const stagingDir = mkdtempSync(path.join(stagingParent, input.stagingPrefix));
  const archivePath = path.join(stagingDir, "bundle.tar.gz");
  const extractDir = path.join(stagingDir, "extract");
  const oldDir = `${targetRoot}.old-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(archivePath, input.bytes);
    mkdirSync(extractDir, { recursive: true });
    extractTarball(archivePath, extractDir);
    writeFileSync(path.join(extractDir, input.markerFile), `${JSON.stringify(input.marker, null, 2)}\n`);

    if (existsSync(targetRoot)) renameSync(targetRoot, oldDir);
    try {
      renameSync(extractDir, targetRoot);
    } catch (error) {
      if (existsSync(oldDir)) renameSync(oldDir, targetRoot);
      throw error;
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
    rmSync(oldDir, { recursive: true, force: true });
  }
}

function extractTarball(archivePath: string, destDir: string): void {
  try {
    safeExtract(archivePath, destDir);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const unsafe = detail.includes("unsafe archive entry");
    throw new OpenCanonError([
      createOpenCanonDiagnostic({
        code: RuntimeUpdateDiagnosticCode.Failed,
        message: unsafe ? "OpenCanon runtime bundle contains an unsafe archive entry." : "Could not extract OpenCanon runtime bundle.",
        details: [detail, `Archive: ${archivePath}`],
      }),
    ]);
  }
}

function readBundleMarker(runtimeRoot: string): BundleMarker | undefined {
  const markerPath = path.join(runtimeRoot, BundleMarkerFile);
  if (!existsSync(markerPath)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8")) as unknown;
    if (!isRecord(parsed)) return undefined;
    const { runtimeVersion, sha256, target } = parsed as { runtimeVersion?: unknown; sha256?: unknown; target?: unknown };
    if (typeof sha256 !== "string" || typeof target !== "string") return undefined;
    if (runtimeVersion !== undefined && typeof runtimeVersion !== "string") return undefined;
    if (!Sha256Pattern.test(sha256) || !isEngineTarget(target)) return undefined;
    return { runtimeVersion, sha256: sha256.toLowerCase(), target };
  } catch {
    return undefined;
  }
}

async function loadRuntimeManifest(source: string, cwd: string): Promise<RuntimeManifestLoad> {
  const manifestSource = await readTextSource(source, cwd);
  // Authenticity gate: for REMOTE (http/s) manifests, verify the detached Ed25519
  // signature over the EXACT manifest bytes BEFORE parsing or trusting any field. The
  // signed manifest is the root of trust for the self-hosted updater; integrity (sha256)
  // alone is not enough. Local file/path manifests are operator-provided and exempt.
  const signature = isRemoteManifestSource(source) ? await loadSignatureSidecar(source, cwd) : undefined;
  const verification = verifyManifestForSource(source, Buffer.from(manifestSource.text, "utf8"), signature);
  if (!verification.ok) {
    throw invalidManifest(manifestSource.input, [
      `Runtime manifest signature could not be verified: ${verification.reason}.`,
      "OpenCanon only installs runtime bundles from remote manifests signed by a trusted release key.",
    ]);
  }
  const manifest = parseRuntimeManifest(manifestSource.text, manifestSource.input);
  return { ...manifestSource, manifest };
}

async function loadSignatureSidecar(source: string, cwd: string): Promise<ManifestSignatureSidecar | undefined> {
  try {
    const sidecar = await readTextSource(signatureSidecarLocation(source), cwd);
    return parseSignatureSidecar(sidecar.text);
  } catch {
    // A missing/unreadable sidecar means the manifest is unsigned to us — rejected by
    // verifyManifestSignature downstream. Signature is mandatory; no unsigned fallback.
    return undefined;
  }
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
  if (typeof parsed.runtimeVersion !== "string" || parsed.runtimeVersion.length === 0) diagnostics.push("runtimeVersion must be a non-empty string.");
  const requiredNode = parseRequiredNode(parsed);
  if (!requiredNode) {
    if (typeof parsed.requiredBun === "string" && parsed.requiredBun.length > 0) {
      diagnostics.push("requiredBun-only manifest describes a Bun-era runtime and is not installable on Node. Re-generate the manifest with `npm run release:manifest` (requiredNode).");
    } else {
      diagnostics.push("requiredNode must be a non-empty string.");
    }
  } else if (!minimumNodeVersionFromRequirement(requiredNode)) diagnostics.push("requiredNode must be a Node semver version or >=semver range.");
  if (!isRecord(parsed.bundles)) diagnostics.push("bundles must be an object keyed by target.");
  if (parsed.apps !== undefined) diagnostics.push("apps is not supported by runtime-only OpenCanon manifests.");

  const bundles = parseTargetAssets(parsed.bundles, "bundles", diagnostics);

  if (diagnostics.length > 0) throw invalidManifest(source, diagnostics);
  return {
    version: RuntimeManifestVersion,
    channel,
    runtimeVersion: parsed.runtimeVersion as string,
    requiredNode: requiredNode ?? requiredNodeRequirement,
    bundles,
  };
}

function parseTargetAssets(value: unknown, field: "bundles", diagnostics: string[]): Partial<Record<EngineTarget, RuntimeBundleAsset>> {
  const output: Partial<Record<EngineTarget, RuntimeBundleAsset>> = {};
  if (isRecord(value)) {
    for (const [target, asset] of Object.entries(value)) {
      if (!isEngineTarget(target)) {
        diagnostics.push(`${field}.${target} is not a supported target.`);
        continue;
      }
      if (!isRecord(asset)) {
        diagnostics.push(`${field}.${target} must be an object.`);
        continue;
      }
      const url = asset.url;
      const sha256 = asset.sha256;
      if (typeof url !== "string" || url.length === 0) diagnostics.push(`${field}.${target}.url must be a non-empty string.`);
      if (typeof sha256 !== "string" || !Sha256Pattern.test(sha256)) diagnostics.push(`${field}.${target}.sha256 must be a 64-character SHA-256 hex string.`);
      if (typeof url === "string" && typeof sha256 === "string" && Sha256Pattern.test(sha256)) {
        output[target] = { url, sha256: sha256.toLowerCase() };
      }
    }
  }
  return output;
}

function validateRuntimeCompatibility(manifest: RuntimeManifest): void {
  const diagnostics: OpenCanonDiagnostic[] = [];
  const minimumNode = minimumNodeVersionFromRequirement(manifest.requiredNode);
  if (!minimumNode || !satisfiesMinimumVersion(currentNodeVersion(), minimumNode)) {
    diagnostics.push(
      createOpenCanonDiagnostic({
        code: RuntimeUpdateDiagnosticCode.Failed,
        message: "Runtime manifest targets an incompatible Node version.",
        details: [`Manifest requires ${manifest.requiredNode}; current runtime is Node ${currentNodeVersion()} (OpenCanon requires ${requiredNodeRequirement}).`],
      }),
    );
  }
  if (diagnostics.length > 0) throw new OpenCanonError(diagnostics);
}

function parseRequiredNode(parsed: Record<string, unknown>): string | undefined {
  // Only an explicit requiredNode is accepted. A requiredBun-only manifest describes
  // a Bun-era bundle and must NOT be installed on Node.
  if (typeof parsed.requiredNode === "string" && parsed.requiredNode.length > 0) return parsed.requiredNode;
  return undefined;
}

function minimumNodeVersionFromRequirement(value: string): string | undefined {
  const trimmed = value.trim();
  const rangeMatch = trimmed.match(/^>=\s*(\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?)$/u);
  if (rangeMatch) return rangeMatch[1];
  const exactMatch = trimmed.match(/^v?\d+\.\d+\.\d+(?:[.-][0-9A-Za-z.-]+)?$/u);
  if (exactMatch) return trimmed;
  return undefined;
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
    const response = await fetchTrusted(parsed, "runtime bundle");
    if (!response.ok) throw updateFailed(`Could not download runtime bundle: ${response.status} ${response.statusText}.`, source);
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
