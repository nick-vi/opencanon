import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createOpenCanonRelease } from "../scripts/create-opencanon-release.ts";

test("release manifest includes available engine assets and checksums", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-release-"));
  const assetDir = path.join(rootDir, "assets");
  const outDir = path.join(rootDir, "dist");
  const runtimeDir = path.join(rootDir, "runtime");
  const binaryName = "opencanon.darwin-arm64.node";
  const bytes = Buffer.from("engine-release-asset");
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  try {
    mkdirSync(assetDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(path.join(assetDir, binaryName), bytes);
    writeFileSync(path.join(runtimeDir, "cli.js"), "export const runtime = true;\n");

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
      engine: Record<string, { sha256: string; url: string }>;
      requiredBun: string;
      runtime: { format: string; sha256: string; url: string };
      skillVersion: string;
      version: number;
    };
    const checksums = readFileSync(result.checksumPath, "utf8");
    const latest = JSON.parse(readFileSync(result.latestPath, "utf8")) as {
      engine: Record<string, { sha256: string; url: string }>;
      skillVersion: string;
      version: number;
    };

    assert.equal(manifest.version, 1);
    assert.equal(manifest.channel, "beta");
    assert.equal(manifest.skillVersion, "0.1.0");
    assert.equal(manifest.requiredBun, "1.3.13");
    assert.equal(manifest.runtime.url, "opencanon-skill-runtime.tar.gz");
    assert.equal(manifest.runtime.format, "tar.gz");
    assert.equal(manifest.runtime.sha256.length, 64);
    assert.equal(manifest.engine["darwin-arm64"].url, binaryName);
    assert.equal(manifest.engine["darwin-arm64"].sha256, sha256);
    assert.equal(latest.version, manifest.version);
    assert.equal(latest.skillVersion, manifest.skillVersion);
    assert.equal(latest.engine["darwin-arm64"].sha256, sha256);
    assert.equal(result.channel, "beta");
    assert(result.runtimeArchivePath);
    assert(checksums.includes(`${sha256}  ${binaryName}`));
    assert(checksums.includes("  latest.json"));
    assert(checksums.includes("  beta.json"));
    assert(checksums.includes("  opencanon-skill-runtime.tar.gz"));
    assert.deepEqual(result.targets, ["darwin-arm64"]);
    assert(result.missingTargets.includes("linux-x64"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("release manifest can require generated skill runtime", () => {
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
  const rootDir = mkdtempSync(
    path.join(tmpdir(), "opencanon-release-missing-"),
  );
  try {
    assert.throws(
      () =>
        createOpenCanonRelease({
          assetDir: rootDir,
          outDir: path.join(rootDir, "dist"),
          requireAll: true,
        }),
      /Missing engine release assets/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
