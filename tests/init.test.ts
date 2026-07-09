import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createPaths, generateProjectTypes } from "@opencanon/core";

const script = path.join(process.cwd(), "packages/cli/src/index.ts");

test("init dry-run reports scaffold without writing files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-dry-run-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--dry-run", "--no-runtime"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert(result.stdout.includes("# OpenCanon Init"));
    assert(!result.stdout.includes("opencanon.config.json"));
    assert.equal(existsSync(path.join(rootDir, "opencanon.config.json")), false);
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md")), false);
    assert.equal(existsSync(path.join(rootDir, "AGENTS.md")), false);
    assert.equal(existsSync(path.join(rootDir, "CLAUDE.md")), false);
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
    const env = { ...process.env, OPENCANON_SERVICE_REGISTRY_PATH: path.join(rootDir, ".opencanon", "test-service.json") };

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--hooks", "opencode", "--file-discovery", "filesystem", "--no-runtime"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(path.join(rootDir, "opencanon.config.json")), false);
    const skill = readFileSync(path.join(rootDir, ".agents/skills/opencanon/SKILL.md"), "utf8");
    assert(skill.includes("Progressive References"));
    assert(skill.includes("opencanon brief --format json"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/references/implementation.md"), "utf8").includes("Implementation Workflow"));
    assert(readFileSync(path.join(rootDir, ".agents/skills/opencanon/scripts/opencanon-brief-context.sh"), "utf8").includes("opencanon brief --format json"));
    assert(readFileSync(path.join(rootDir, "AGENTS.md"), "utf8").includes("<opencanon>"));
    assert(readFileSync(path.join(rootDir, "AGENTS.md"), "utf8").includes("opencanon brief --format json"));
    assert(readFileSync(path.join(rootDir, "AGENTS.md"), "utf8").includes("Treat human attention as scarce."));
    assert(readFileSync(path.join(rootDir, "CLAUDE.md"), "utf8").includes("<opencanon>"));
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/.gitignore")), false);
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/index.ts")), false);
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/testing.ts")), false);
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/package.json")), false);
    const conventionTsconfig = readFileSync(path.join(rootDir, "opencanon/tsconfig.json"), "utf8");
    assert(conventionTsconfig.includes("@opencanon/core"));
    assert(conventionTsconfig.includes("@opencanon/core/testing"));
    assert(conventionTsconfig.includes("@opencanon/validators"));
    assert(conventionTsconfig.includes("@opencanon/project"));
    const conventionTsconfigJson = JSON.parse(conventionTsconfig) as { compilerOptions: { ignoreDeprecations?: string; types?: unknown } };
    assert.equal(conventionTsconfigJson.compilerOptions.ignoreDeprecations, "6.0");
    assert.equal(conventionTsconfigJson.compilerOptions.types, undefined);
    assert(readFileSync(path.join(rootDir, "opencanon/fixtures/tsconfig.json"), "utf8").includes("../tsconfig.json"));
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/runtime/cli.js")), false);
    assert(readFileSync(path.join(rootDir, "opencanon/conventions/index.ts"), "utf8").includes("export default []"));
    assert(readFileSync(path.join(rootDir, "opencanon/areas/index.ts"), "utf8").includes("export default []"));
    assert(readFileSync(path.join(rootDir, "opencanon/changes/index.ts"), "utf8").includes("export default []"));
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/scripts/opencanon.mjs")), false);
    assert.equal(existsSync(path.join(rootDir, ".agents/skills/opencanon/scripts/opencode-plugin.ts")), false);
    assert(readFileSync(path.join(rootDir, ".opencode/plugins/opencanon.ts"), "utf8").includes('opencanon", ["hook", "opencode"]'));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/generated/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/cache/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes("tmp/"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/init.json"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/*.sqlite"));
    assert(readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".opencanon/semantic-index/"));
    assert(!readFileSync(path.join(rootDir, ".gitignore"), "utf8").includes(".agents/skills/opencanon/runtime/"));
    assert.equal(JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")).scripts.opencanon, "opencanon");

    const check = spawnSync(process.execPath, [script, "context", "--check"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
    });
    assert.equal(check.status, 0, check.stderr || check.stdout);

    const doctor = spawnSync(process.execPath, [script, "doctor"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
    });
    assert.equal(doctor.status, 0, doctor.stderr || doctor.stdout);
    assert(doctor.stdout.includes("not applicable outside the OpenCanon framework workspace"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init patches only the managed OpenCanon agent entry block", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-agent-entry-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    writeFileSync(path.join(rootDir, "AGENTS.md"), "# Team Rules\n\nKeep this human-owned note.\n\n<opencanon>\nstale\n</opencanon>\n");

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--no-runtime"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const agents = readFileSync(path.join(rootDir, "AGENTS.md"), "utf8");
    assert(agents.includes("Keep this human-owned note."));
    assert(!agents.includes("\nstale\n"));
    assert(agents.includes("opencanon context --files <paths...>"));
    assert(agents.includes("Prefer finished, proven slices of work over partial edits."));
    assert(readFileSync(path.join(rootDir, "CLAUDE.md"), "utf8").includes("Use OpenCanon CLI or MCP for live project state."));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init derives authoring tsconfig scaffold from custom convention paths", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-custom-paths-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync(
      process.execPath,
      [script, "init", "--yes", "--no-runtime", "--conventions-path", "canon/conventions/index.ts", "--fixtures-dir", "canon/fixtures", "--docs-dir", "canon/docs"],
      {
        cwd: rootDir,
        encoding: "utf8",
      },
    );

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert.equal(existsSync(path.join(rootDir, "opencanon/tsconfig.json")), false);
    assert.equal(existsSync(path.join(rootDir, "opencanon/fixtures/tsconfig.json")), false);
    assert.equal(existsSync(path.join(rootDir, "canon/tsconfig.json")), true);
    assert.equal(existsSync(path.join(rootDir, "canon/fixtures/tsconfig.json")), true);
    const conventionTsconfig = readFileSync(path.join(rootDir, "canon/tsconfig.json"), "utf8");
    assert(conventionTsconfig.includes("conventions/**/*.ts"));
    assert(conventionTsconfig.includes("../.opencanon/generated/authoring/core.d.ts"));
    assert(conventionTsconfig.includes("../.opencanon/generated/authoring/validators.d.ts"));
    const fixtureTsconfig = readFileSync(path.join(rootDir, "canon/fixtures/tsconfig.json"), "utf8");
    assert(fixtureTsconfig.includes("../tsconfig.json"));
    assert(fixtureTsconfig.includes("../../.opencanon/generated/authoring/testing.d.ts"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("generated authoring support writes typed package and import constants", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-authoring-types-"));
  try {
    mkdirSync(path.join(rootDir, "packages/domain/src"), { recursive: true });
    mkdirSync(path.join(rootDir, "crates/demo-core/src"), { recursive: true });
    mkdirSync(path.join(rootDir, "python"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/fixtures/demo"), { recursive: true });
    writeFileSync(
      path.join(rootDir, "package.json"),
      JSON.stringify({
        type: "module",
        workspaces: ["packages/*"],
        dependencies: { react: "^19.0.0" },
      }),
    );
    writeFileSync(
      path.join(rootDir, "packages/domain/package.json"),
      JSON.stringify({
        name: "@demo/domain",
        description: "Shared domain primitives.",
        private: true,
        dependencies: { zod: "^4.0.0" },
      }),
    );
    writeFileSync(
      path.join(rootDir, "packages/domain/src/index.ts"),
      [
        'import { z } from "zod";',
        "",
        "export const status = \"active\";",
        "export function formatCompany(name: string) {",
        "  return z.string().parse(name);",
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
      path.join(rootDir, "opencanon/fixtures/demo/valid.ts"),
      ['import db, { query } from "@demo/domain/db";', 'import { z } from "zod";', "export const ok = query(db, z);", ""].join("\n"),
    );

    const payload = generateProjectTypes(rootDir, createPaths(rootDir));
    assert.equal(payload.path, ".opencanon/generated/authoring/project.ts");
    assert.equal(payload.packageCount, 2);
    assert(payload.importSpecifierCount >= 3);
    assert(payload.npmDependencyCount >= 2);
    assert.equal(payload.crateCount, 1);
    assert.equal(payload.cargoDependencyCount, 3);
    assert.equal(payload.pythonDependencyCount, 6);
    assert(payload.aliasModuleCount >= 3);
    assert.equal(payload.authoringDeclarationCount, 3);

    const source = readFileSync(path.join(rootDir, ".opencanon/generated/authoring/project.ts"), "utf8");
    assert(source.includes('import "@opencanon/core";'));
    assert(source.includes("export const Packages = {"));
    assert(source.includes("DEMO_DOMAIN: \"@demo/domain\""));
    assert(source.includes("ROOT: \"<root>\""));
    assert(source.includes("Shared domain primitives."));
    assert(source.includes("Package: @demo/domain"));
    assert(!readFileSync(path.join(rootDir, ".opencanon/generated/authoring/core.d.ts"), "utf8").includes("content?: string; executable?: boolean"));
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
    assert(!source.includes('"packages/domain/src/index.ts": {'));
    assert(!source.includes('stringLiterals: "active";'));
    assert(source.includes("export type ProjectImportRecord ="));
    assert(source.includes("export type ProjectStringLiteralRecord ="));
    assert(!source.includes("export type ProjectCallEdgeRecord"));
    assert(!source.includes("export type ProjectCallees"));
    assert(!source.includes("export type CalleesOf"));
    assert(source.includes('declare module "@opencanon/core"'));
    assert(source.includes("interface OpenCanonProjectIndex extends ProjectIndex"));
    const aliases = readFileSync(path.join(rootDir, ".opencanon/generated/authoring/aliases.d.ts"), "utf8");
    assert(aliases.includes('declare module "@demo/domain"'));
    assert(aliases.includes('declare module "@demo/domain/*"'));
    assert(aliases.includes('declare module "@demo/domain/db"'));
    assert(aliases.includes("export const query: any;"));
    assert(aliases.includes('declare module "zod"'));
    assert(aliases.includes("export const z: any;"));
    const coreDeclarations = readFileSync(path.join(rootDir, ".opencanon/generated/authoring/core.d.ts"), "utf8");
    assert(coreDeclarations.includes("export declare function defineConvention"));
    assert(!coreDeclarations.includes("defineAgentSkill"));
    assert(!coreDeclarations.includes("AgentSkillResource"));
    assert(coreDeclarations.includes("export declare function createConventionFactory"));
    const testingDeclarations = readFileSync(path.join(rootDir, ".opencanon/generated/authoring/testing.d.ts"), "utf8");
    assert(testingDeclarations.includes("export declare function defineFixture"));
    const validatorDeclarations = readFileSync(path.join(rootDir, ".opencanon/generated/authoring/validators.d.ts"), "utf8");
    assert(validatorDeclarations.includes("export declare const noNativeEnums"));
    assert(validatorDeclarations.includes("export declare const sensitiveChangePolicy"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init writes config only for non-default options", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-config-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--docs-dir", "canon-docs", "--no-runtime"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    assert(result.stdout.includes("create: opencanon.config.json"));
    assert.deepEqual(JSON.parse(readFileSync(path.join(rootDir, "opencanon.config.json"), "utf8")), {
      docsDir: "canon-docs",
      impactSurfacesPath: "canon-docs/impact-surfaces.json",
      proposedImpactNotesPath: "canon-docs/proposed-impact-notes.json",
    });
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("init repairs missing scaffold without overwriting existing files", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-init-existing-"));
  try {
    writeFileSync(path.join(rootDir, "package.json"), JSON.stringify({ type: "module" }));
    mkdirSync(path.join(rootDir, "docs/opencanon"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/conventions"), { recursive: true });
    writeFileSync(path.join(rootDir, "opencanon/conventions/index.ts"), "export default [];\n");

    const result = spawnSync(process.execPath, [script, "init", "--yes", "--no-runtime", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const payload = JSON.parse(result.stdout) as { steps: Array<{ id: string; status: string; details?: string[] }> };
    assert.equal(payload.steps.find((step) => step.id === "scaffold")?.status, "pass");
    assert.equal(readFileSync(path.join(rootDir, "opencanon/conventions/index.ts"), "utf8"), "export default [];\n");
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
