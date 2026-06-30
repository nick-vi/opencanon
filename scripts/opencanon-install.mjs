#!/usr/bin/env node
import { createHash, createPublicKey, verify as cryptoVerify } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform, arch, tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const defaultManifest = "https://github.com/nick-vi/opencanon/releases/latest/download/opencanon-runtime-manifest.json";
const trustedReleaseKeys = /* OPENCANON_TRUSTED_RELEASE_KEYS */ [];
const manifestSource = process.argv[2] ?? process.env.OPENCANON_UPDATE_MANIFEST ?? defaultManifest;
const installRoot = process.env.OPENCANON_HOME ? path.resolve(process.env.OPENCANON_HOME) : path.join(homedir(), ".opencanon");
const runtimeRoot = process.env.OPENCANON_RUNTIME_ROOT ? path.resolve(process.env.OPENCANON_RUNTIME_ROOT) : path.join(installRoot, "runtime");
const binDir = path.join(installRoot, "bin");

const target = currentTarget();
const loaded = await readManifest(manifestSource);
const runtimeAsset = loaded.manifest.bundles?.[target];
if (!runtimeAsset) throw new Error(`Manifest has no runtime bundle for ${target}.`);

await installAsset(runtimeAsset, loaded, runtimeRoot, { runtimeVersion: loaded.manifest.runtimeVersion, sha256: runtimeAsset.sha256, target }, ".bundle.json");

writeLaunchers();

console.log(`OpenCanon ${loaded.manifest.runtimeVersion} installed.`);
console.log(`Runtime: ${runtimeRoot}`);
console.log(`CLI launcher: ${path.join(binDir, process.platform === "win32" ? "opencanon.cmd" : "opencanon")}`);
console.log(`Add ${binDir} to PATH if it is not already there.`);

function currentTarget() {
  const key = `${platform()}-${arch()}`;
  if (key === "darwin-arm64" || key === "darwin-x64" || key === "linux-arm64" || key === "linux-x64" || key === "win32-x64") return key;
  throw new Error(`Unsupported platform: ${key}.`);
}

async function readManifest(source) {
  const bytes = await readBytes(source);
  const signature = isRemoteManifestSource(source) ? await readSignatureSidecar(source) : undefined;
  const verification = verifyManifestForSource(source, bytes, signature);
  if (!verification.ok) throw new Error(`Manifest signature could not be verified: ${verification.reason}.`);
  const text = Buffer.from(bytes).toString("utf8");
  const manifest = JSON.parse(text);
  if (manifest.version !== 1) throw new Error("Manifest version must be 1.");
  if (!manifest.runtimeVersion || typeof manifest.runtimeVersion !== "string") throw new Error("Manifest runtimeVersion is missing.");
  if (!manifest.requiredNode || typeof manifest.requiredNode !== "string") throw new Error("Manifest requiredNode is missing.");
  if (!manifest.bundles || typeof manifest.bundles !== "object") throw new Error("Manifest bundles are missing.");
  return { manifest, source };
}

async function readSignatureSidecar(source) {
  try {
    return parseSignatureSidecar(Buffer.from(await readBytes(signatureSidecarLocation(source))).toString("utf8"));
  } catch {
    return undefined;
  }
}

function signatureSidecarLocation(source) {
  try {
    const url = new URL(source);
    url.pathname = `${url.pathname}.sig`;
    return url.toString();
  } catch {
    return `${source}.sig`;
  }
}

function parseSignatureSidecar(text) {
  try {
    const parsed = JSON.parse(text);
    if (!parsed || parsed.algorithm !== "ed25519" || typeof parsed.keyId !== "string" || typeof parsed.value !== "string") return undefined;
    return { keyId: parsed.keyId, algorithm: "ed25519", value: parsed.value };
  } catch {
    return undefined;
  }
}

function verifyManifestForSource(source, manifestBytes, signature) {
  if (!isRemoteManifestSource(source)) return { ok: true };
  if (!signature) return { ok: false, reason: "manifest signature sidecar is missing or malformed" };
  if (signature.algorithm !== "ed25519") return { ok: false, reason: `unsupported signature algorithm: ${String(signature.algorithm)}` };
  const trusted = trustedReleaseKeys.find((key) => key.keyId === signature.keyId);
  if (!trusted) return { ok: false, reason: `signature keyId is not trusted: ${signature.keyId}` };
  if (trusted.revoked) return { ok: false, reason: `signature keyId is revoked: ${signature.keyId}` };
  try {
    const signatureBytes = Buffer.from(signature.value, "base64");
    if (signatureBytes.length !== 64) return { ok: false, reason: "signature has wrong length for Ed25519" };
    const publicKey = createPublicKey({ key: Buffer.from(trusted.publicKeySpkiBase64, "base64"), format: "der", type: "spki" });
    return cryptoVerify(null, Buffer.from(manifestBytes), publicKey, signatureBytes)
      ? { ok: true }
      : { ok: false, reason: "signature does not match any trusted key" };
  } catch (error) {
    return { ok: false, reason: `signature verification failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

function isRemoteManifestSource(source) {
  try {
    const url = new URL(source);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

async function installAsset(asset, manifest, destination, marker, markerFile) {
  if (!asset || typeof asset.url !== "string" || typeof asset.sha256 !== "string") throw new Error("Invalid asset entry.");
  const source = resolveAsset(asset.url, manifest.source);
  const bytes = await readBytes(source);
  const actualSha = createHash("sha256").update(bytes).digest("hex");
  if (actualSha !== asset.sha256.toLowerCase()) throw new Error(`Checksum mismatch for ${source}. Expected ${asset.sha256}, got ${actualSha}.`);

  const parent = path.dirname(destination);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, ".opencanon-install-"));
  const archive = path.join(staging, "bundle.tar.gz");
  const extract = path.join(staging, "extract");
  const old = `${destination}.old-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(archive, bytes);
    assertArchivePathsSafe(archive, source);
    mkdirSync(extract, { recursive: true });
    const tar = spawnSync("tar", ["-xzf", archive, "-C", extract], { encoding: "utf8" });
    if (tar.status !== 0) throw new Error(`Could not extract ${source}: ${tar.stderr || tar.stdout}`);
    writeFileSync(path.join(extract, markerFile), `${JSON.stringify(marker, null, 2)}\n`);
    if (existsSync(destination)) renameSync(destination, old);
    try {
      renameSync(extract, destination);
    } catch (error) {
      if (existsSync(old)) renameSync(old, destination);
      throw error;
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
    rmSync(old, { recursive: true, force: true });
  }
}

function assertArchivePathsSafe(archive, source) {
  const list = spawnSync("tar", ["-tzf", archive], { encoding: "utf8" });
  if (list.status !== 0) throw new Error(`Could not inspect ${source}: ${list.stderr || list.stdout}`);
  const unsafe = list.stdout
    .split(/\r?\n/u)
    .filter(Boolean)
    .find((entry) => {
      const normalized = path.posix.normalize(entry.replaceAll("\\", "/"));
      return normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:\//u.test(normalized);
    });
  if (unsafe) throw new Error(`Archive ${source} contains an unsafe path: ${unsafe}`);
}

function writeLaunchers() {
  mkdirSync(binDir, { recursive: true });
  const cliPath = path.join(runtimeRoot, "cli.js");
  if (process.platform === "win32") {
    writeFileSync(path.join(binDir, "opencanon.cmd"), `@echo off\r\nnode "${cliPath}" %*\r\n`);
    return;
  }
  const launcher = path.join(binDir, "opencanon");
  writeFileSync(launcher, `#!/usr/bin/env sh\nexec node "${cliPath}" "$@"\n`, { mode: 0o755 });
}

function resolveAsset(assetUrl, manifestSource) {
  try {
    return new URL(assetUrl, manifestSource).toString();
  } catch {
    if (path.isAbsolute(assetUrl)) return assetUrl;
    if (isUrl(manifestSource)) return new URL(assetUrl, manifestSource).toString();
    return path.resolve(path.dirname(path.resolve(manifestSource)), assetUrl);
  }
}

async function readBytes(source) {
  if (isUrl(source)) {
    const response = await fetch(source);
    if (!response.ok) throw new Error(`Fetch failed for ${source}: HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  }
  return readFileSync(source.startsWith("file:") ? new URL(source) : source);
}

function isUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "file:";
  } catch {
    return false;
  }
}
