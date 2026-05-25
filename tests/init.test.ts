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

test("init creates scaffold, package script, and requested hooks", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-"));
  try {
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "src/a.ts"), "export const a = 1;\n");

    const result = spawnSync("bun", [script, "init", "--non-interactive", "--hooks", "opencode", "--file-discovery", "filesystem"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(path.join(rootDir, "opencanon.config.json")), false);
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md"), "utf8").includes("Validator Authoring"));
    assert.equal(readFileSync(path.join(rootDir, ".agents/skills/opencanon/.gitignore"), "utf8"), "runtime/\ngenerated/\n");
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/index.ts"), "utf8").includes("./runtime/validators.js"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/testing.ts"), "utf8").includes("defineFixture"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/tsconfig.json"), "utf8").includes("@opencanon/project"));
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, ".agents/skills/opencanon/package.json"), "utf8")).name, "@opencanon/skill");
    assert(existsSync(path.join(rootDir, ".agents/skills/opencanon/runtime/cli.js")));
    assert(existsSync(path.join(rootDir, ".agents/skills/opencanon/runtime/engine", engineTarget, engineBindingName)));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/validators/index.ts"), "utf8").includes("export default []"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/scripts/opencanon.ts"), "utf8").includes("runtime/cli.js"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/scripts/opencode-plugin.ts"), "utf8").includes("../runtime/cli.js"));
    assert(readFileSync(path.join(rootDir, ".opencode/plugins/opencanon.ts"), "utf8").includes(".agents/skills/opencanon/scripts/opencode-plugin.ts"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/cache/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/setup.json"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/*.sqlite"));
    assert(!readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".agents/skills/opencanon/runtime/"));
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

test("project-types generate writes typed package and import constants", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-project-types-"));
  try {
    mkdirSync(path.join(rootDir, "packages/ui/src"), { recursive: true });
    mkdirSync(path.join(rootDir, "crates/demo-core/src"), { recursive: true });
    mkdirSync(path.join(rootDir, "python"), { recursive: true });
    mkdirSync(path.join(rootDir, ".agents/skills/opencanon/fixtures/demo"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        type: "module",
        workspaces: ["packages/*"],
        dependencies: { react: "^19.0.0" },
      }),
    );
    writeFileSync(
      path.join(rootDir, "packages/ui/package.json"),
      JSON.stringify({
        name: "@demo/ui",
        description: "Shared UI primitives.",
        private: true,
        dependencies: { zod: "^4.0.0" },
      }),
    );
    writeFileSync(
      path.join(rootDir, "packages/ui/src/index.ts"),
      [
        'import { z } from "zod";',
        "",
        "export const status = \"active\";",
        "export function renderButton(label: string) {",
        "  return z.string().parse(label);",
        "}",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(rootDir, "crates/demo-core/Cargo.toml"),
      [
        "[package]",
        'name = "demo-core"',
        'version = "0.1.0"',
        'description = "Core Rust crate."',
        "",
        "[dependencies]",
        'serde = { version = "1.0", features = ["derive"] }',
        'tokio = "1"',
        "",
        "[build-dependencies]",
        'cc = "1"',
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(rootDir, "crates/demo-core/src/lib.rs"), "pub fn demo() {}\n");
    writeFileSync(
      path.join(rootDir, "python/pyproject.toml"),
      [
        "[project]",
        'dependencies = ["requests>=2,<3", "pydantic[email]==2.7.0"]',
        "",
        "[project.optional-dependencies]",
        'test = ["pytest~=8.0"]',
        "",
        "[tool.poetry.dependencies]",
        'python = "^3.12"',
        'django = "^5.0"',
        "",
      ].join("\n"),
    );
    writeFileSync(path.join(rootDir, "python/requirements-dev.txt"), "ruff==0.8.0\npython-dotenv>=1\n");
    writeFileSync(
      path.join(rootDir, ".agents/skills/opencanon/fixtures/demo/valid.ts"),
      ['import db, { query } from "@demo/ui/db";', 'import { z } from "zod";', "export const ok = query(db, z);", ""].join("\n"),
    );

    const result = spawnSync("bun", [script, "project-types", "generate", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as {
      path: string;
      packageCount: number;
      importSpecifierCount: number;
      npmDependencyCount: number;
      crateCount: number;
      cargoDependencyCount: number;
      pythonDependencyCount: number;
      aliasModuleCount: number;
    };
    assert.equal(payload.path, ".agents/skills/opencanon/generated/project.ts");
    assert.equal(payload.packageCount, 2);
    assert(payload.importSpecifierCount >= 3);
    assert(payload.npmDependencyCount >= 2);
    assert.equal(payload.crateCount, 1);
    assert.equal(payload.cargoDependencyCount, 3);
    assert.equal(payload.pythonDependencyCount, 6);
    assert(payload.aliasModuleCount >= 3);

    const source = readFileSync(path.join(rootDir, ".agents/skills/opencanon/generated/project.ts"), "utf8");
    assert(source.includes('import "@opencanon/core";'));
    assert(source.includes("export const Packages = {"));
    assert(source.includes("DEMO_UI: \"@demo/ui\""));
    assert(source.includes("ROOT: \"<root>\""));
    assert(source.includes("Shared UI primitives."));
    assert(source.includes("Package: @demo/ui"));
    assert(source.includes("export type PackageName = (typeof Packages)[keyof typeof Packages];"));
    assert(source.includes("REACT: \"react\""));
    assert(source.includes("ZOD: \"zod\""));
    assert(source.includes("export const Npm = {"));
    assert(source.includes('REACT: {"name":"react","version":"^19.0.0"'));
    assert(source.includes('ZOD: {"name":"zod","version":"^4.0.0"'));
    assert(source.includes("export type NpmDependencyName = NpmDependency[\"name\"];"));
    assert(source.includes("export type NpmDependencyVersion = NpmDependency[\"version\"];"));
    assert(source.includes("export const Crates = {"));
    assert(source.includes("DEMO_CORE: \"demo-core\""));
    assert(source.includes("Core Rust crate."));
    assert(source.includes("Crate: demo-core"));
    assert(source.includes("CrateRoots"));
    assert(source.includes("DEMO_CORE: \"crates/demo-core\""));
    assert(source.includes("export const Cargo = {"));
    assert(source.includes('SERDE: {"name":"serde","version":"1.0","section":"dependencies"}'));
    assert(source.includes('TOKIO: {"name":"tokio","version":"1","section":"dependencies"}'));
    assert(source.includes('CC: {"name":"cc","version":"1","section":"build-dependencies"}'));
    assert(source.includes("export type CargoDependencyName = CargoDependency[\"name\"];"));
    assert(source.includes("export type CargoDependencyVersion = CargoDependency[\"version\"];"));
    assert(source.includes("Section: build-dependencies"));
    assert(source.includes("export type CrateName = (typeof Crates)[keyof typeof Crates];"));
    assert(source.includes("export type CargoDependency = (typeof Cargo)[keyof typeof Cargo];"));
    assert(source.includes("export const Python = {"));
    assert(source.includes('REQUESTS: {"name":"requests","version":">=2,<3","source":"python/pyproject.toml","group":"project.dependencies"}'));
    assert(source.includes('PYDANTIC: {"name":"pydantic","version":"==2.7.0","source":"python/pyproject.toml","group":"project.dependencies"}'));
    assert(source.includes('PYTEST: {"name":"pytest","version":"~=8.0","source":"python/pyproject.toml","group":"project.optional-dependencies.test"}'));
    assert(source.includes('DJANGO: {"name":"django","version":"^5.0","source":"python/pyproject.toml","group":"tool.poetry.dependencies"}'));
    assert(source.includes('RUFF: {"name":"ruff","version":"==0.8.0","source":"python/requirements-dev.txt","group":"requirements.dev"}'));
    assert(source.includes('PYTHON_DOTENV: {"name":"python-dotenv","version":">=1","source":"python/requirements-dev.txt","group":"requirements.dev"}'));
    assert(source.includes("export type PythonDependencyName = PythonDependency[\"name\"];"));
    assert(source.includes("export type PythonDependencyVersion = PythonDependency[\"version\"];"));
    assert(source.includes("export type ProjectIndex = {"));
    assert(source.includes('files: Record<string, import("@opencanon/core").OpenCanonProjectIndexFile>;'));
    assert(source.includes("symbolIds: string;"));
    assert(!source.includes('"packages/ui/src/index.ts": {'));
    assert(!source.includes('stringLiterals: "active";'));
    assert(source.includes("export type ProjectImportRecord ="));
    assert(source.includes("export type ProjectStringLiteralRecord ="));
    assert(!source.includes("export type ProjectCallEdgeRecord"));
    assert(!source.includes("export type ProjectCallees"));
    assert(!source.includes("export type CalleesOf"));
    assert(source.includes('declare module "@opencanon/core"'));
    assert(source.includes("interface OpenCanonProjectIndex extends ProjectIndex"));
    const aliases = readFileSync(path.join(rootDir, ".agents/skills/opencanon/generated/aliases.d.ts"), "utf8");
    assert(aliases.includes('declare module "@demo/ui"'));
    assert(aliases.includes('declare module "@demo/ui/*"'));
    assert(aliases.includes('declare module "@demo/ui/db"'));
    assert(aliases.includes("export const query: any;"));
    assert(aliases.includes('declare module "zod"'));
    assert(aliases.includes("export const z: any;"));
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
