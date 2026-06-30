import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const script = path.join(process.cwd(), "packages/cli/src/index.ts");

test("setup requires explicit consent before writing", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-setup-consent-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync(process.execPath, [script, "setup", "--no-runtime"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert(`${result.stderr}\n${result.stdout}`.includes("opencanon setup requires explicit consent"));
    assert.equal(existsSync(path.join(rootDir, "AGENTS.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("setup dry-run reports init actions without writing files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-setup-dry-run-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync(process.execPath, [script, "setup", "--dry-run", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { dryRun: boolean; packet?: unknown; init: { steps: Array<{ id: string; status: string }> } };
    assert.equal(payload.dryRun, true);
    assert.equal(payload.packet, undefined);
    assert.equal(payload.init.steps.find((step) => step.id === "scaffold")?.status, "pass");
    assert.equal(existsSync(path.join(rootDir, "AGENTS.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("setup initializes a repo and emits an agent setup packet", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-setup-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "src/app.ts"), "export const app = true;\n");

    const result = spawnSync(process.execPath, [script, "setup", "--yes", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      timeout: 30_000,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      packet: {
        schema: string;
        discovery: { fileCount: number; languageCounts: Record<string, number>; sampleFiles: string[] };
        existingCanon: { areas: number; specs: number; changes: number; conventions: number };
        agentWorkflow: string[];
        suggestedCommands: string[];
      };
    };
    assert.notEqual(payload.status, "fail");
    assert.equal(payload.packet.schema, "opencanon.setup-packet.v1");
    assert(payload.packet.discovery.fileCount >= 2);
    assert.equal(payload.packet.discovery.languageCounts.ts, 1);
    assert(payload.packet.discovery.sampleFiles.includes("src/app.ts"));
    assert.deepEqual(payload.packet.existingCanon, { areas: 0, specs: 0, changes: 0, conventions: 0, validators: 0, impactSurfaces: 0 });
    assert(payload.packet.agentWorkflow.some((item) => item.includes("Ask the user")));
    assert(payload.packet.suggestedCommands.includes("opencanon brief --format json"));
    assert(readFileSync(path.join(rootDir, "AGENTS.md"), "utf8").includes("opencanon brief --format json"));
    assert(readFileSync(path.join(rootDir, "AGENTS.md"), "utf8").includes("Treat human attention as scarce."));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md"), "utf8").includes("opencanon setup --yes --format json"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
