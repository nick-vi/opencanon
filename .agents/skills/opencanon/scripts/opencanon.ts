#!/usr/bin/env bun
import { createHash } from "node:crypto";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const skillRoot = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
process.env.OPENCANON_SKILL_ROOT = skillRoot;
const runtimeCli = "runtime/cli.js";
const runtimeCliPath = path.join(skillRoot, runtimeCli);
const sourceCliPath = path.resolve(skillRoot, "../../..", "packages/cli/src/index.ts");
const sourceCheckout = existsSync(sourceCliPath);
const defaultManifestUrl = "https://github.com/nick-vi/opencanon/releases/download/v0.3.5/opencanon-runtime-manifest.json";
const cliArgs = Bun.argv.slice(2);
const manifestArg = resolveManifestArg(cliArgs) ?? process.env.OPENCANON_UPDATE_MANIFEST ?? null;
const bootstrapManifest = manifestArg ?? defaultManifestUrl;

if (!existsSync(runtimeCliPath) && !sourceCheckout) {
  await installRuntimeFromManifest(bootstrapManifest);
}

const cliPath = existsSync(runtimeCliPath) ? runtimeCliPath : sourceCliPath;
if (!existsSync(cliPath)) throw new Error(`OpenCanon runtime is missing after bootstrap: ${runtimeCli}`);

const cli = await import(pathToFileURL(cliPath).href);
if (typeof cli.runOpenCanonCli !== "function") {
  throw new Error(`OpenCanon CLI ${path.relative(skillRoot, cliPath)} does not export runOpenCanonCli().`);
}

if (!manifestArg && !sourceCheckout && cliPath === runtimeCliPath && shouldUseDefaultManifest(cliArgs)) {
  cliArgs.push("--manifest", bootstrapManifest);
}

await cli.runOpenCanonCli(cliArgs);

function resolveManifestArg(args: string[]): string | null {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--manifest") return args[index + 1] ?? null;
    if (arg.startsWith("--manifest=")) return arg.slice("--manifest=".length);
  }
  return null;
}

function shouldUseDefaultManifest(args: string[]): boolean {
  const command = args[0];
  if (command === "setup") return true;
  if (command === "update" && (args[1] === "check" || args[1] === "apply")) return true;
  return false;
}

async function installRuntimeFromManifest(manifestRef: string) {
  const manifestUrl = toUrl(manifestRef);
  const manifest = await readJson(manifestUrl);
  const runtime = manifest.runtime;
  if (!runtime || runtime.format !== "tar.gz" || typeof runtime.url !== "string" || typeof runtime.sha256 !== "string") {
    throw new Error("OpenCanon manifest does not contain a tar.gz runtime asset.");
  }

  const runtimeUrl = new URL(runtime.url, manifestUrl);
  if (!["https:", "file:"].includes(runtimeUrl.protocol)) {
    throw new Error(`OpenCanon runtime URL must use https: or file:, got ${runtimeUrl.protocol}`);
  }

  const archiveBytes = await readBytes(runtimeUrl);
  const actual = createHash("sha256").update(archiveBytes).digest("hex");
  if (actual !== runtime.sha256) throw new Error(`OpenCanon runtime checksum mismatch: expected ${runtime.sha256}, got ${actual}`);

  const tempDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-"));
  const archivePath = path.join(tempDir, "runtime.tar.gz");
  try {
    writeFileSync(archivePath, archiveBytes);
    assertSafeArchive(archivePath);
    const result = Bun.spawnSync(["tar", "-xzf", archivePath, "-C", skillRoot], { stdout: "pipe", stderr: "pipe" });
    if (!result.success) throw new Error(`OpenCanon runtime extraction failed: ${new TextDecoder().decode(result.stderr).trim()}`);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }

  if (!existsSync(runtimeCliPath)) throw new Error(`OpenCanon runtime archive did not install ${runtimeCli}.`);
}

async function readJson(url: URL): Promise<any> {
  const bytes = await readBytes(url);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function readBytes(url: URL): Promise<Uint8Array> {
  if (url.protocol === "file:") return await Bun.file(fileURLToPath(url)).bytes();
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to download ${url.href}: HTTP ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

function toUrl(value: string): URL {
  if (/^[a-z][a-z0-9+.-]*:/iu.test(value)) return new URL(value);
  return pathToFileURL(path.resolve(value));
}

function assertSafeArchive(archivePath: string) {
  const result = Bun.spawnSync(["tar", "-tzf", archivePath], { stdout: "pipe", stderr: "pipe" });
  if (!result.success) throw new Error(`OpenCanon runtime archive listing failed: ${new TextDecoder().decode(result.stderr).trim()}`);

  const entries = new TextDecoder().decode(result.stdout).split(/\r?\n/u).filter(Boolean);
  for (const entry of entries) {
    if (path.isAbsolute(entry) || entry.includes("..") || !entry.startsWith("runtime/")) {
      throw new Error(`OpenCanon runtime archive contains unsafe entry: ${entry}`);
    }
  }
}
