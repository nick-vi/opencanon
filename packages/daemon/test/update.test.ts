import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { applyRuntimeUpdate, checkRuntimeUpdate, currentEngineTarget, engineRuntimePathForTarget } from "@opencanon/daemon";

const engineBindingSuffixes: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
  "win32-x64": "win32-x64-msvc",
};

function buildBundle(stagingRoot: string, target: string, engineBytes: Buffer): { archivePath: string; sha256: string } {
  const stage = path.join(stagingRoot, "stage");
  const engineDir = path.join(stage, "engine", target);
  mkdirSync(engineDir, { recursive: true });
  writeFileSync(path.join(stage, "cli.js"), "export const runtime = true;\n");
  writeFileSync(path.join(stage, "validators.js"), "export const validators = true;\n");
  writeFileSync(path.join(engineDir, `opencanon.${engineBindingSuffixes[target]}.node`), engineBytes);
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
          skillVersion: "0.1.0",
          requiredBun: "1.3.13",
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

    const installed = await applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot });
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
        skillVersion: "0.2.0",
        requiredBun: "1.3.13",
        bundles: { [target]: { url: path.basename(archivePath), sha256 } },
      }),
    );

    const result = await applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot });
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
        skillVersion: "0.1.0",
        requiredBun: "1.3.13",
        bundles: { [target]: { url: path.basename(archivePath), sha256: "0".repeat(64) } },
      }),
    );

    await assert.rejects(() => applyRuntimeUpdate({ manifestSource: manifestPath, cwd: rootDir, runtimeRoot }), /checksum/);
    assert(!existsSync(runtimeRoot), "runtimeRoot should not be created on checksum failure");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("runtime update rejects insecure HTTP manifest sources", async () => {
  await assert.rejects(() => checkRuntimeUpdate({ manifestSource: "http://127.0.0.1:9/opencanon-runtime-manifest.json" }), /insecure HTTP/);
});
