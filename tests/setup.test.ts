import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { currentEngineTarget, engineRuntimePathForTarget } from "@opencanon/daemon";

const script = path.join(process.cwd(), ".agents/skills/opencanon/scripts/opencanon.ts");

test("setup scaffolds missing files, installs requested hooks, validates, and writes setup state", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-setup-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "sample.ts"), "export const sample = true;\n");

    const result = spawnSync("bun", [script, "setup", "--yes", "--hooks", "opencode", "--no-daemon", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      steps: Array<{ id: string; status: string }>;
      init?: Record<string, unknown>;
    };
    assert.equal(payload.status, "warn");
    assert.equal(payload.steps.find((step) => step.id === "scaffold")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "feedback-hooks")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "context")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "project-validation")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "daemon")?.status, "skip");

    assert(existsSync(path.join(rootDir, ".agents/skills/opencanon/runtime/cli.js")));
    assert.equal(readFileSync(path.join(rootDir, ".agents/skills/opencanon/.gitignore"), "utf8"), "runtime/\n");
    assert(existsSync(path.join(rootDir, ".opencode/plugins/opencanon.ts")));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/setup.json"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/cache/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/*.sqlite"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/daemon.log"));
    assert(!readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".agents/skills/opencanon/runtime/"));
    const setupState = JSON.parse(readFileSync(path.join(rootDir, ".opencanon/setup.json"), "utf8")) as { status: string; steps: unknown[] };
    assert.equal(setupState.status, "warn");
    assert(setupState.steps.length >= payload.steps.length);

    writeFileSync(path.join(rootDir, ".gitignore"), readFileSync(path.join(rootDir, ".gitignore"), "utf8").replace(".opencanon/cache/\n", ""));

    const rerun = spawnSync("bun", [script, "setup", "--yes", "--no-daemon", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    const rerunPayload = JSON.parse(rerun.stdout) as { steps: Array<{ id: string; status: string }> };
    assert.equal(rerunPayload.steps.find((step) => step.id === "scaffold")?.status, "skip");
    assert.equal(rerunPayload.steps.find((step) => step.id === "cache-ignore")?.status, "pass");
    assert.equal(rerunPayload.steps.find((step) => step.id === "skill-runtime-ignore")?.status, "pass");
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/cache/"));
    assert.equal(readFileSync(path.join(rootDir, ".agents/skills/opencanon/.gitignore"), "utf8"), "runtime/\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("setup dry-run reports planned scaffold without writing files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-setup-dry-run-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync("bun", [script, "setup", "--yes", "--dry-run", "--no-daemon", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { status: string; steps: Array<{ id: string; status: string }> };
    assert.equal(payload.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "scaffold")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "validation")?.status, "skip");
    assert.equal(payload.steps.find((step) => step.id === "setup-state")?.status, "skip");
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md")), false);
    assert.equal(existsSync(path.join(rootDir, ".opencanon/setup.json")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("setup can install engine runtime from a release manifest", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-setup-manifest-"));
  const target = currentEngineTarget();
  const bytes = Buffer.from("manifest-engine-runtime");
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const assetPath = path.join(rootDir, "asset.node");
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "sample.ts"), "export const sample = true;\n");
    writeFileSync(assetPath, bytes);
    writeFileSync(
      manifestPath,
      JSON.stringify({
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
      }),
    );

    const result = spawnSync("bun", [script, "setup", "--yes", "--manifest", manifestPath, "--no-daemon", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { steps: Array<{ id: string; status: string }> };
    assert.equal(payload.steps.find((step) => step.id === "runtime-update")?.status, "pass");
    assert.equal(readFileSync(engineRuntimePathForTarget(path.join(rootDir, ".agents/skills/opencanon/runtime"), target)).toString(), "manifest-engine-runtime");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
