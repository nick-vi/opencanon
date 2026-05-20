import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";

const script = path.join(process.cwd(), ".agents/skills/opencanon/scripts/opencanon.ts");
const engineBindingSuffixes: Record<string, string> = {
  "darwin-arm64": "darwin-arm64",
  "darwin-x64": "darwin-x64",
  "linux-arm64": "linux-arm64-gnu",
  "linux-x64": "linux-x64-gnu",
  "win32-x64": "win32-x64-msvc",
};
const engineTarget = `${process.platform}-${process.arch}`;
const engineBindingName = `opencanon.${engineBindingSuffixes[engineTarget]}.node`;

test("init dry-run reports scaffold without writing files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-dry-run-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync("bun", [script, "init", "--yes", "--dry-run"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert(result.stdout.includes("# OpenCanon Init"));
    assert(!result.stdout.includes("opencanon.config.json"));
    assert.equal(existsSync(path.join(rootDir, "opencanon.config.json")), false);
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md")), false);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init creates scaffold, agent brief, package script, and requested hooks", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "src/a.ts"), "export const a = 1;\n");

    const result = spawnSync("bun", [script, "init", "--yes", "--agent", "--hooks", "opencode", "--file-discovery", "filesystem"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert(result.stdout.includes("Agent Setup Brief"));
    assert.equal(existsSync(path.join(rootDir, "opencanon.config.json")), false);
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md"), "utf8").includes("Validator Authoring"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/index.ts"), "utf8").includes("./runtime/validators.js"));
    assert(existsSync(path.join(rootDir, ".agents/skills/opencanon/runtime/cli.js")));
    assert(existsSync(path.join(rootDir, ".agents/skills/opencanon/runtime/engine", engineTarget, engineBindingName)));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/validators/index.ts"), "utf8").includes("export default []"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/scripts/opencanon.ts"), "utf8").includes("runtime/cli.js"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/scripts/opencode-plugin.ts"), "utf8").includes("../runtime/cli.js"));
    assert(readFileSync(path.join(rootDir, ".opencode/plugins/opencanon.ts"), "utf8").includes(".agents/skills/opencanon/scripts/opencode-plugin.ts"));
    assert(readFileSync(path.join(rootDir, "tmp/opencanon-init-plan.md"), "utf8").includes("OpenCanon Agent Setup Brief"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/cache/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/setup.json"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/*.sqlite"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".agents/skills/opencanon/runtime/"));
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).scripts.opencanon, "bun .agents/skills/opencanon/scripts/opencanon.ts");

    const localScript = path.join(rootDir, ".agents/skills/opencanon/scripts/opencanon.ts");
    const check = spawnSync("bun", [localScript, "context", "--check"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const doctor = spawnSync("bun", [localScript, "doctor"], {
      cwd: rootDir,
      encoding: "utf8",
    });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assert(doctor.stdout.includes("not applicable outside the OpenCanon framework workspace"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init writes config only for non-default options", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-config-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync("bun", [script, "init", "--yes", "--file-discovery", "git"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert(result.stdout.includes("[create] opencanon.config.json"));
    assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, "opencanon.config.json"), "utf8")), { fileDiscovery: "git" });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init refuses to overwrite existing scaffold without force", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-existing-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(path.join(rootDir, "docs/opencanon"), { recursive: true });
    writeFileSync(path.join(rootDir, "docs/opencanon/decisions.json"), "existing\n");

    const result = spawnSync("bun", [script, "init", "--yes"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 1);
    assert(result.stdout.includes("already exists"));
    assert.equal(readFileSync(path.join(rootDir, "docs/opencanon/decisions.json"), "utf8"), "existing\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
