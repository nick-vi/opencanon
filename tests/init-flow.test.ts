import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const script = path.join(process.cwd(), "packages/cli/src/index.ts");

test("init scaffolds missing files, installs requested hooks, validates, and writes init state", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "sample.ts"), "export const sample = true;\n");

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--hooks", "opencode", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as {
      status: string;
      steps: Array<{ id: string; status: string; details?: string[] }>;
      init?: Record<string, unknown>;
    };
    assert.equal(payload.status, "warn");
    assert.equal(payload.steps.find((step) => step.id === "scaffold")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "feedback-hooks")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "context")?.status, "pass");
    assert(payload.steps.find((step) => step.id === "doctor")?.details?.some((detail) => detail.includes("safe fixes applied")));
    assert.equal(payload.steps.find((step) => step.id === "project-validation")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "runtime")?.status, "skip");

    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/runtime/cli.js")), false);
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/.gitignore")), false);
    assert(readFileSync(path.join(rootDir, "AGENTS.md"), "utf8").includes("<opencanon>"));
    assert(readFileSync(path.join(rootDir, "AGENTS.md"), "utf8").includes("Treat human attention as scarce."));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md"), "utf8").includes("opencanon worktree create <change-id> --task <task-id>"));
    assert(readFileSync(path.join(rootDir, "CLAUDE.md"), "utf8").includes("opencanon validate --changed"));
    assert.equal(existsSync(path.join(rootDir, ".husky/pre-commit")), true);
    assert(readFileSync(path.join(rootDir, ".husky/pre-commit"), "utf8").includes("opencanon validate --changed"));
    assert(existsSync(path.join(rootDir, ".opencode/plugins/opencanon.ts")));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes("tmp/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/generated/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/init.json"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/cache/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/processes/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/state/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/check-*/"));
    assert(!readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".agents/skills/opencanon/runtime/"));
    const initState = JSON.parse(readFileSync(path.join(rootDir, ".opencanon/init.json"), "utf8")) as { status: string; steps: unknown[] };
    assert.equal(initState.status, "warn");
    assert(initState.steps.length >= payload.steps.length);

    writeFileSync(path.join(rootDir, ".gitignore"), readFileSync(path.join(rootDir, ".gitignore"), "utf8").replace(".opencanon/cache/\n", ""));

    const rerun = spawnSync(process.execPath, [script, "init", "--yes", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    const rerunPayload = JSON.parse(rerun.stdout) as { steps: Array<{ id: string; status: string }> };
    assert.equal(rerunPayload.steps.find((step) => step.id === "scaffold")?.status, "skip");
    assert.equal(rerunPayload.steps.find((step) => step.id === "cache-ignore")?.status, "pass");
    assert.equal(rerunPayload.steps.find((step) => step.id === "init-state-ignore")?.status, "pass");
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/cache/"));
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/.gitignore")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init dry-run reports planned scaffold without writing files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-dry-run-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--dry-run", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { status: string; steps: Array<{ id: string; status: string }> };
    assert.equal(payload.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "scaffold")?.status, "pass");
    assert.equal(payload.steps.find((step) => step.id === "validation")?.status, "skip");
    assert.equal(payload.steps.find((step) => step.id === "init-state")?.status, "skip");
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md")), false);
    assert.equal(existsSync(path.join(rootDir, "AGENTS.md")), false);
    assert.equal(existsSync(path.join(rootDir, "CLAUDE.md")), false);
    assert.equal(existsSync(path.join(rootDir, ".opencanon/init.json")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init validates change links against loaded specs", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-spec-links-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    const initial = spawnSync(process.execPath, [script, "init", "--yes", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(initial.status, 0, initial.stderr || initial.stdout);
    writeFileSync(
      path.join(rootDir, "opencanon/specs/index.ts"),
      `import { defineSpec } from "@opencanon/core";

export default [
  defineSpec({
    id: "demo-spec",
    title: "Demo Spec",
    summary: "Demo behavior stays explicit.",
    scope: [{ kind: "file", path: "src/demo.js" }],
    rules: [{ id: "demo-rule", statement: "Demo rule.", acceptance: ["Demo acceptance."] }],
    render: { kind: "none" },
  }),
];
`,
    );
    writeFileSync(
      path.join(rootDir, "opencanon/changes/index.ts"),
      `import { defineChange } from "@opencanon/core";

export default [
  defineChange({
    id: "demo-change",
    title: "Demo Change",
    kind: "feature",
    summary: "Demo change.",
    intent: { problem: "Missing demo.", outcome: "Demo exists." },
    updates: { specs: ["demo-spec"] },
    scope: [{ kind: "file", path: "src/demo.js" }],
    render: { kind: "none" },
  }),
];
`,
    );

    const rerun = spawnSync(process.execPath, [script, "init", "--yes", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(rerun.status, 0, rerun.stderr || rerun.stdout);
    const payload = JSON.parse(rerun.stdout) as { steps: Array<{ id: string; status: string; details?: string[] }> };
    const contextStep = payload.steps.find((step) => step.id === "context");
    assert.equal(contextStep?.status, "pass");
    assert.equal((contextStep?.details ?? []).some((detail) => detail.includes("references missing spec")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init repairs partial text-only skill scaffold", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-partial-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module", scripts: { opencanon: "opencanon" } }));
    const skillDir = path.join(rootDir, ".agents/skills/opencanon");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "# OpenCanon\n");

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { steps: Array<{ id: string; status: string; details?: string[] }> };
    const scaffold = payload.steps.find((step) => step.id === "scaffold");
    assert.equal(scaffold?.status, "pass");
    assert(scaffold?.details?.some((detail) => detail.includes("missing before init: opencanon/conventions/index.ts")));
    assert(scaffold?.details?.some((detail) => detail.includes("missing before init: opencanon/areas/index.ts")));
    assert(scaffold?.details?.some((detail) => detail.includes("missing before init: opencanon/changes/index.ts")));
    assert(scaffold?.details?.some((detail) => detail.includes("missing before init: opencanon/tsconfig.json")));
    assert.equal(existsSync(path.join(skillDir, "testing.ts")), false);
    assert.equal(existsSync(path.join(rootDir, "opencanon/fixtures/tsconfig.json")), true);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init repairs scaffold at configured convention paths", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-custom-paths-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module", scripts: { opencanon: "opencanon" } }));
    writeFileSync(
      path.join(rootDir, "opencanon.config.json"),
      JSON.stringify({
        docsDir: "canon/docs",
        conventionsPath: "canon/conventions/index.ts",
        areasPath: "canon/areas/index.ts",
        changesPath: "canon/changes/index.ts",
        fixturesDir: "canon/fixtures",
        cacheDir: ".canon/cache",
        fileDiscovery: "filesystem",
        projectFilePatterns: ["src/**/*.ts"],
        requiredPackageScripts: [],
      }),
    );

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { steps: Array<{ id: string; status: string; details?: string[] }> };
    const scaffold = payload.steps.find((step) => step.id === "scaffold");
    assert.equal(scaffold?.status, "pass");
    assert(scaffold?.details?.some((detail) => detail.includes("missing before init: canon/conventions/index.ts")));
    assert(scaffold?.details?.some((detail) => detail.includes("missing before init: canon/areas/index.ts")));
    assert(scaffold?.details?.some((detail) => detail.includes("missing before init: canon/changes/index.ts")));
    assert(scaffold?.details?.some((detail) => detail.includes("missing before init: canon/tsconfig.json")));
    assert.equal(existsSync(path.join(rootDir, "canon/conventions/index.ts")), true);
    assert.equal(existsSync(path.join(rootDir, "canon/areas/index.ts")), true);
    assert.equal(existsSync(path.join(rootDir, "canon/changes/index.ts")), true);
    assert.equal(existsSync(path.join(rootDir, "canon/tsconfig.json")), true);
    assert.equal(existsSync(path.join(rootDir, "canon/fixtures/tsconfig.json")), true);
    assert.equal(existsSync(path.join(rootDir, "opencanon/tsconfig.json")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init rejects the removed release manifest option", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-manifest-"));
  const manifestPath = path.join(rootDir, "manifest.json");

  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "sample.ts"), "export const sample = true;\n");
    writeFileSync(manifestPath, "{}\n");

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--manifest", manifestPath, "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.notEqual(result.status, 0);
    assert(`${result.stderr}\n${result.stdout}`.includes("Unknown option"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
