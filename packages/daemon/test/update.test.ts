import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { applyRuntimeUpdate, checkRuntimeUpdate, currentEngineTarget, engineRuntimePathForTarget } from "@opencanon/daemon";

test("runtime update installs the current engine target from a verified manifest", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-update-"));
  const runtimeRoot = path.join(rootDir, "runtime");
  const target = currentEngineTarget();
  const bytes = Buffer.from("engine-binary");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const assetPath = path.join(rootDir, "asset.node");
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    writeFileSync(assetPath, bytes);
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          skillVersion: "0.1.0",
          requiredBun: "1.3.13",
          daemonSchema: 1,
          engine: {
            [target]: {
              url: "./asset.node",
              sha256,
              schemaVersion: 1,
            },
          },
        },
        null,
        2,
      ),
    );

    const missing = await checkRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot });
    assert.equal(missing.status, "missing");
    assert.equal(missing.target, target);

    const installed = await applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot });
    assert.equal(installed.status, "installed");
    assert.equal(readFileSync(engineRuntimePathForTarget(runtimeRoot, target)).toString(), "engine-binary");

    const current = await checkRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot });
    assert.equal(current.status, "current");
    assert.equal(current.currentSha256, sha256);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime update rejects checksum mismatches", async () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-runtime-update-bad-"));
  const runtimeRoot = path.join(rootDir, "runtime");
  const target = currentEngineTarget();
  const assetPath = path.join(rootDir, "asset.node");
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    writeFileSync(assetPath, "engine-binary");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          version: 1,
          skillVersion: "0.1.0",
          requiredBun: "1.3.13",
          daemonSchema: 1,
          engine: {
            [target]: {
              url: "./asset.node",
              sha256: "0".repeat(64),
              schemaVersion: 1,
            },
          },
        },
        null,
        2,
      ),
    );

    await assert.rejects(() => applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot }), /checksum/);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime update rejects insecure HTTP manifest sources", async () => {
  await assert.rejects(() => checkRuntimeUpdate({ manifestSource: "http://127.0.0.1:9/opencanon-runtime-manifest.json" }), /insecure HTTP/);
});
