import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { applyRuntimeUpdate, checkRuntimeUpdate, currentEngineTarget, engineRuntimePathForTarget, type EngineTarget, type UpdateSafetyGuard } from "@opencanon/distribution";

const updateSafety: UpdateSafetyGuard = {
  assertSafeToUpdate() {},
};

function buildBundle(stagingRoot: string, target: EngineTarget, engineBytes: Buffer): { archivePath: string; sha256: string } {
  const stage = path.join(stagingRoot, "stage");
  // Derive the engine binary path the same way production does — no local suffix table.
  const enginePath = engineRuntimePathForTarget(stage, target);
  mkdirSync(path.dirname(enginePath), { recursive: true });
  writeFileSync(path.join(stage, "cli.js"), "export const runtime = true;\n");
  writeFileSync(path.join(stage, "validators.js"), "export const validators = true;\n");
  writeFileSync(enginePath, engineBytes);
  const archivePath = path.join(stagingRoot, "bundle.tar.gz");
  const result = spawnSync("tar", ["-czf", archivePath, "-C", stage, "."], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`tar failed: ${result.stderr}`);
  const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
  return { archivePath, sha256 };
}

test("runtime update installs the current engine target from a verified manifest", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-update-"));
  const runtimeRoot = path.join(rootDir, "runtime");
  const target = currentEngineTarget();
  const engineBytes = Buffer.from("engine-binary");
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    const { archivePath, sha256 } = buildBundle(rootDir, target, engineBytes);
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          runtimeVersion: "0.1.0",
          requiredNode: ">=24.12.0",
          bundles: {
            [target]: { url: path.basename(archivePath), sha256 },
          },
        },
        null,
        2,
      ),
    );

    const missing = await checkRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot });
    assert.equal(missing.status, "missing");
    assert.equal(missing.target, target);
    assert.equal(missing.requiredNode, ">=24.12.0");

    const installed = await applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot, safety: updateSafety });
    assert.equal(installed.status, "installed");
    assert.equal(readFileSync(engineRuntimePathForTarget(runtimeRoot, target)).toString(), "engine-binary");
    assert.equal(readFileSync(path.join(runtimeRoot, "cli.js")).toString().trim(), "export const runtime = true;");
    const marker = JSON.parse(readFileSync(path.join(runtimeRoot, ".bundle.json"), "utf8")) as { sha256: string; target: string };
    assert.equal(marker.sha256, sha256);
    assert.equal(marker.target, target);

    const current = await checkRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot });
    assert.equal(current.status, "current");
    assert.equal(current.currentSha256, sha256);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime update atomically swaps an existing runtime directory", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-update-swap-"));
  const runtimeRoot = path.join(rootDir, "runtime");
  const target = currentEngineTarget();
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    mkdirSync(runtimeRoot, { recursive: true });
    writeFileSync(path.join(runtimeRoot, "stale.txt"), "from previous install");

    const { archivePath, sha256 } = buildBundle(rootDir, target, Buffer.from("fresh-engine"));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        runtimeVersion: "0.2.0",
        requiredNode: ">=24.12.0",
        bundles: { [target]: { url: path.basename(archivePath), sha256 } },
      }),
    );

    const result = await applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot, safety: updateSafety });
    assert.equal(result.status, "installed");
    assert(!existsSync(path.join(runtimeRoot, "stale.txt")), "stale file should be removed by atomic swap");
    assert(existsSync(path.join(runtimeRoot, "cli.js")));
    assert(existsSync(path.join(runtimeRoot, ".bundle.json")));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime update rejects checksum mismatches", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-update-bad-"));
  const runtimeRoot = path.join(rootDir, "runtime");
  const target = currentEngineTarget();
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    const { archivePath } = buildBundle(rootDir, target, Buffer.from("engine-binary"));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        runtimeVersion: "0.1.0",
        requiredNode: ">=24.12.0",
        bundles: { [target]: { url: path.basename(archivePath), sha256: "0".repeat(64) } },
      }),
    );

    await assert.rejects(() => applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot, safety: updateSafety }), /checksum/);
    assert(!existsSync(runtimeRoot), "runtimeRoot should not be created on checksum failure");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime update requires the caller safety guard before installing", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-update-safety-"));
  const runtimeRoot = path.join(rootDir, "runtime");
  const target = currentEngineTarget();
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    const { archivePath, sha256 } = buildBundle(rootDir, target, Buffer.from("engine-binary"));
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        runtimeVersion: "0.1.0",
        requiredNode: ">=24.12.0",
        bundles: { [target]: { url: path.basename(archivePath), sha256 } },
      }),
    );

    await assert.rejects(
      () => applyRuntimeUpdate({
        manifestSource: manifestPath,
        cwd: rootDir,
        runtimeRoot,
        safety: {
          assertSafeToUpdate() {
            throw new Error("blocked by safety guard");
          },
        },
      }),
      /blocked by safety guard/,
    );
    assert(!existsSync(runtimeRoot), "runtimeRoot should not be created when the guard rejects");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime update rejects insecure HTTP manifest sources", async () => {
  await assert.rejects(() => checkRuntimeUpdate({ manifestSource: "http://127.0.0.1:9/opencanon-runtime-manifest.json" }), /insecure HTTP/);
});

test("runtime update rejects requiredBun-only manifests", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencanon-bun-era-manifest-"));
  try {
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ version: 1, runtimeVersion: "0.1.0", requiredBun: "1.3.13", bundles: { [currentEngineTarget()]: { url: "bundle.tar.gz", sha256: "0".repeat(64) } } }),
    );
    await assert.rejects(() => checkRuntimeUpdate({ manifestSource: manifestPath }), /Bun-era/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime update rejects app bundle manifests on the runtime-only surface", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "opencanon-app-era-manifest-"));
  try {
    const manifestPath = path.join(dir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        runtimeVersion: "0.1.0",
        requiredNode: ">=24.12.0",
        bundles: { [currentEngineTarget()]: { url: "bundle.tar.gz", sha256: "0".repeat(64) } },
        apps: { [currentEngineTarget()]: { url: "app.tar.gz", sha256: "0".repeat(64) } },
      }),
    );
    await assert.rejects(() => checkRuntimeUpdate({ manifestSource: manifestPath }), /apps is not supported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime update rejects bundles containing symlink entries", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-unsafe-"));
  const runtimeRoot = path.join(rootDir, "runtime");
  const target = currentEngineTarget();
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    // Stage a bundle whose engine binary is a symlink to an absolute host path — the
    // archive-safety check must reject it before extraction touches the filesystem.
    const stage = path.join(rootDir, "stage");
    const enginePath = engineRuntimePathForTarget(stage, target);
    mkdirSync(path.dirname(enginePath), { recursive: true });
    writeFileSync(path.join(stage, "cli.js"), "export const runtime = true;\n");
    writeFileSync(path.join(stage, "validators.js"), "export const validators = true;\n");
    assert.equal(spawnSync("ln", ["-s", "/etc/passwd", enginePath]).status, 0, "could not stage symlink");
    const archivePath = path.join(rootDir, "bundle.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", archivePath, "-C", stage, "."]).status, 0, "could not build archive");
    const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        runtimeVersion: "0.2.0",
        requiredNode: ">=24.12.0",
        bundles: { [target]: { url: path.basename(archivePath), sha256 } },
      }),
    );

    await assert.rejects(() => applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot, safety: updateSafety }), /unsafe archive entry/);
    assert(!existsSync(path.join(runtimeRoot, "cli.js")), "no files should be extracted from an unsafe bundle");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime update rejects bundles containing hardlink entries", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-hardlink-"));
  const runtimeRoot = path.join(rootDir, "runtime");
  const target = currentEngineTarget();
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    const stage = path.join(rootDir, "stage");
    const enginePath = engineRuntimePathForTarget(stage, target);
    mkdirSync(path.dirname(enginePath), { recursive: true });
    const realFile = path.join(stage, "cli.js");
    writeFileSync(realFile, "export const runtime = true;\n");
    writeFileSync(path.join(stage, "validators.js"), "export const validators = true;\n");
    writeFileSync(enginePath, "engine");
    // Hard link (no -s) — node-tar's link handling is the classic traversal vector, so a
    // hardlink entry must be rejected just like a symlink.
    assert.equal(spawnSync("ln", [realFile, path.join(stage, "alias.js")]).status, 0, "could not stage hardlink");
    const archivePath = path.join(rootDir, "bundle.tar.gz");
    assert.equal(spawnSync("tar", ["-czf", archivePath, "-C", stage, "."]).status, 0, "could not build archive");
    const sha256 = createHash("sha256").update(readFileSync(archivePath)).digest("hex");
    writeFileSync(
      manifestPath,
      JSON.stringify({
        version: 1,
        runtimeVersion: "0.2.0",
        requiredNode: ">=24.12.0",
        bundles: { [target]: { url: path.basename(archivePath), sha256 } },
      }),
    );

    await assert.rejects(() => applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot, safety: updateSafety }), /unsafe archive entry/);
    assert(!existsSync(path.join(runtimeRoot, "cli.js")), "no files should be extracted from an unsafe bundle");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
