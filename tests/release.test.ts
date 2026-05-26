import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createOpenCanonRelease } from "../scripts/create-opencanon-release.ts";

test("release manifest emits one bundle per available engine target", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-release-"));
  const assetDir = path.join(rootDir, "assets");
  const outDir = path.join(rootDir, "dist");
  const runtimeDir = path.join(rootDir, "runtime");
  const binaryName = "opencanon.darwin-arm64.node";
  const engineBytes = Buffer.from("engine-release-asset");

  try {
    mkdirSync(assetDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(path.join(assetDir, binaryName), engineBytes);
    writeFileSync(path.join(runtimeDir, "cli.js"), "export const runtime = true;\n");
    writeFileSync(path.join(runtimeDir, "validators.js"), "export const validators = true;\n");

    const result = createOpenCanonRelease({
      assetDir,
      clean: true,
      channel: "beta",
      outDir,
      requireRuntime: true,
      runtimeDir,
      skillVersion: "0.1.0",
    });

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
      channel: string;
      bundles: Record<string, { sha256: string; url: string }>;
      requiredBun: string;
      skillVersion: string;
      version: number;
    };
    const checksums = readFileSync(result.checksumPath, "utf8");

    assert.equal(manifest.version, 1);
    assert.equal(manifest.channel, "beta");
    assert.equal(manifest.skillVersion, "0.1.0");
    assert.equal(manifest.requiredBun, "1.3.13");
    assert(!Object.prototype.hasOwnProperty.call(manifest, "daemonSchema"));
    assert(!Object.prototype.hasOwnProperty.call(manifest, "engine"));
    assert(!Object.prototype.hasOwnProperty.call(manifest, "runtime"));
    const bundle = manifest.bundles["darwin-arm64"];
    assert(bundle, "bundle for darwin-arm64 must exist");
    assert.equal(bundle.url, "opencanon-runtime-darwin-arm64.tar.gz");
    assert.equal(bundle.sha256.length, 64);

    const bundlePath = result.bundlePaths["darwin-arm64"];
    assert(bundlePath, "bundle path recorded");
    const actualSha = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
    assert.equal(actualSha, bundle.sha256);

    // Bundle should extract to a tree containing cli.js, validators.js, engine/darwin-arm64/<binding>.node.
    const extractDir = path.join(rootDir, "extract");
    mkdirSync(extractDir, { recursive: true });
    const tarResult = spawnSync("tar", ["-xzf", bundlePath, "-C", extractDir], { encoding: "utf8" });
    assert.equal(tarResult.status, 0, tarResult.stderr);
    const enginePath = path.join(extractDir, "engine", "darwin-arm64", binaryName);
    assert.equal(readFileSync(enginePath).toString(), "engine-release-asset");
    assert(readdirSync(path.join(extractDir, "engine")).includes("darwin-arm64"));
    assert.equal(readdirSync(path.join(extractDir, "engine")).length, 1, "bundle must contain only matching target's engine");

    assert(checksums.includes("  opencanon-runtime-darwin-arm64.tar.gz"));
    assert(checksums.includes("  latest.json"));
    assert(checksums.includes("  beta.json"));
    assert.deepEqual(result.targets, ["darwin-arm64"]);
    assert(result.missingTargets.includes("linux-x64"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("release manifest requires a generated skill runtime", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-release-runtime-"));
  const assetDir = path.join(rootDir, "assets");
  const binaryName = "opencanon.darwin-arm64.node";

  try {
    mkdirSync(assetDir, { recursive: true });
    writeFileSync(path.join(assetDir, binaryName), "engine");

    assert.throws(
      () =>
        createOpenCanonRelease({
          assetDir,
          outDir: path.join(rootDir, "dist"),
          requireRuntime: true,
          runtimeDir: path.join(rootDir, "missing-runtime"),
        }),
      /Missing generated skill runtime/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("release manifest can require every engine target", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-release-missing-"));
  const runtimeDir = path.join(rootDir, "runtime");
  try {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(path.join(runtimeDir, "cli.js"), "export const runtime = true;\n");
    assert.throws(
      () =>
        createOpenCanonRelease({
          assetDir: rootDir,
          outDir: path.join(rootDir, "dist"),
          requireAll: true,
          runtimeDir,
        }),
      /Missing engine release assets/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
