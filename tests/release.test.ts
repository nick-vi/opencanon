import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { createPaths, discoverProjectFiles } from "@opencanon/core";
import { OpenCanonSkillArtifacts } from "../packages/core/src/opencanon-skill.ts";
import { createOpenCanonRelease } from "../scripts/create-opencanon-release.ts";

const TestTreeCoverageRoots = ["tests", "packages/runtime/test", "packages/distribution/test", "packages/observability/test"] as const;

function collectTestFiles(dir: string): string[] {
  const entries = readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) return collectTestFiles(filePath);
    if (!/\.(?:test|spec)\.(?:ts|tsx|js|mjs)$/.test(entry.name)) return [];
    return [filePath.replace(/\\/g, "/")];
  });
}

function isCoveredByTestTree(script: string, filePath: string): boolean {
  if (script.includes(filePath)) return true;
  if (filePath.startsWith("packages/observability/test/") && script.includes("packages/observability/test/*.test.ts")) return true;
  return false;
}

function expandedScript(packageJson: { scripts?: Record<string, string> }, names: string[]): string {
  return names.map((name) => packageJson.scripts?.[name] ?? "").join(" && ");
}

test("test:tree includes every repo test file", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = expandedScript(packageJson, ["test:tree", "test:tree:parallel", "test:runtime-integration"]);
  const missing = TestTreeCoverageRoots.flatMap((root) => collectTestFiles(root))
    .sort()
    .filter((filePath) => !isCoveredByTestTree(script, filePath));

  assert.deepEqual(missing, []);
});

test("project discovery governs every authored Rust crate source", () => {
  const tracked = spawnSync("git", ["ls-files", "--", "crates"], { encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  const authoredRust = tracked.stdout
    .split(/\r?\n/)
    .filter((filePath) => /^crates\/[^/]+\/src\/.*\.rs$/.test(filePath))
    .sort();
  const discovery = discoverProjectFiles(createPaths(process.cwd()));

  assert.equal(discovery.failed, false, discovery.diagnostics.join("\n"));
  const discovered = new Set(discovery.files);
  assert.deepEqual(authoredRust.filter((filePath) => !discovered.has(filePath)), []);
});

test("repo tracks managed OpenCanon skill artifacts required by doctor", () => {
  const untracked = OpenCanonSkillArtifacts.map((artifact) => artifact.path).filter(
    (artifactPath) => spawnSync("git", ["ls-files", "--error-unmatch", "--", artifactPath], { encoding: "utf8" }).status !== 0,
  );

  assert.deepEqual(untracked, []);
});

test("example projects do not track generated OpenCanon runtime or skill internals", () => {
  const tracked = spawnSync("git", ["ls-files", "--", "examples/projects"], { encoding: "utf8" });
  assert.equal(tracked.status, 0, tracked.stderr);
  const stale = tracked.stdout
    .split(/\r?\n/)
    .filter(Boolean)
    .filter((filePath) =>
      filePath.includes("/.opencanon/") ||
      filePath.includes("/.agents/skills/opencanon/fixtures/") ||
      filePath.includes("/.agents/skills/opencanon/validators/") ||
      filePath.endsWith("/.agents/skills/opencanon/.gitignore"),
    );

  assert.deepEqual(stale, []);
});

test("release manifest emits one bundle per available engine target", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-release-"));
  const assetDir = path.join(rootDir, "assets");
  const outDir = path.join(rootDir, "dist");
  const runtimeDir = path.join(rootDir, "runtime");
  const binaryName = "opencanon.darwin-arm64.node";
  const engineBytes = Buffer.from("engine-release-asset");

  try {
    mkdirSync(assetDir, { recursive: true });
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(path.join(assetDir, binaryName), engineBytes);
    writeFileSync(path.join(runtimeDir, "cli.js"), "export const runtime = true;\n");
    writeFileSync(path.join(runtimeDir, "validators.js"), "export const validators = true;\n");

    const result = createOpenCanonRelease({
      assetDir,
      clean: true,
      channel: "beta",
      outDir,
      requireRuntime: true,
      runtimeDir,
      runtimeVersion: "0.1.0",
    });

    const manifest = JSON.parse(readFileSync(result.manifestPath, "utf8")) as {
      channel: string;
      bundles: Record<string, { sha256: string; url: string }>;
      requiredNode: string;
      runtimeVersion: string;
      version: number;
    };
    const checksums = readFileSync(result.checksumPath, "utf8");

    assert.equal(manifest.version, 1);
    assert.equal(manifest.channel, "beta");
    assert.equal(manifest.runtimeVersion, "0.1.0");
    assert.equal(manifest.requiredNode, ">=24.12.0");
    assert(!Object.prototype.hasOwnProperty.call(manifest, "engine"));
    assert(!Object.prototype.hasOwnProperty.call(manifest, "runtime"));
    assert(!Object.prototype.hasOwnProperty.call(manifest, "apps"));
    const bundle = manifest.bundles["darwin-arm64"];
    assert(bundle, "bundle for darwin-arm64 must exist");
    assert.equal(bundle.url, "opencanon-runtime-darwin-arm64.tar.gz");
    assert.equal(bundle.sha256.length, 64);
    assert.equal(path.basename(result.installerPath), "opencanon-install.mjs");
    assert(!readFileSync(result.installerPath, "utf8").includes("OPENCANON_TRUSTED_RELEASE_KEYS"));

    const bundlePath = result.bundlePaths["darwin-arm64"];
    assert(bundlePath, "bundle path recorded");
    const actualSha = createHash("sha256").update(readFileSync(bundlePath)).digest("hex");
    assert.equal(actualSha, bundle.sha256);

    // Bundle should extract to a tree containing cli.js, validators.js, engine/darwin-arm64/<binding>.node.
    const extractDir = path.join(rootDir, "extract");
    mkdirSync(extractDir, { recursive: true });
    const tarResult = spawnSync("tar", ["-xzf", bundlePath, "-C", extractDir], { encoding: "utf8" });
    assert.equal(tarResult.status, 0, tarResult.stderr);
    const enginePath = path.join(extractDir, "engine", "darwin-arm64", binaryName);
    assert.equal(readFileSync(enginePath).toString(), "engine-release-asset");
    assert(readdirSync(path.join(extractDir, "engine")).includes("darwin-arm64"));
    assert.equal(readdirSync(path.join(extractDir, "engine")).length, 1, "bundle must contain only matching target's engine");

    assert(checksums.includes("  opencanon-runtime-darwin-arm64.tar.gz"));
    assert(checksums.includes("  opencanon-install.mjs"));
    assert(checksums.includes("  latest.json"));
    assert(checksums.includes("  beta.json"));
    assert.deepEqual(result.targets, ["darwin-arm64"]);
    assert(result.missingTargets.includes("linux-x64"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("bundled macOS Node runtime includes portable dynamic library handling", () => {
  const source = readFileSync("scripts/build-opencanon-runtime.ts", "utf8");

  assert.match(source, /copyDarwinNodeDependencies\(source, target\)/);
  assert.match(source, /darwinDependencies/);
  assert.match(source, /install_name_tool/);
  assert.match(source, /codesign/);
  assert.match(source, /signDarwinBinary\(targetBinary\)/);
  assert.match(source, /@loader_path\/\.\.\/lib/);
  assert.match(source, /@rpath\/\$\{path\.basename\(resolved\)\}/);
  assert.match(source, /!file\.startsWith\("\/usr\/lib\/"\) && !file\.startsWith\("\/System\/"\)/);
});

test("install rehearsal stops isolated processes before applying updates", () => {
  const source = readFileSync("scripts/rehearse-opencanon-install.ts", "utf8");

  assert.match(source, /function stopRehearsalProcesses/);
  assert.match(source, /\[sourceCliScript, "project", "stop"\]/);
  assert.match(source, /\[sourceCliScript, "service", "stop"\]/);
  assert.match(source, /stopRehearsalProcesses\(commands, repo, runtimeRoot, registryPath\);\s*run\(\s*commands,\s*process\.execPath,\s*\[\s*sourceCliScript,\s*"update",\s*"apply"/s);
  assert.match(source, /finally \{[\s\S]*stopRehearsalProcesses\(undefined, repo, runtimeRoot, registryPath\)/);
  assert(!source.includes("OPENCANON_RUNTIME_TRANSPORT"));
});

test("release publish dispatches and watches the exact tagged commit", () => {
  const source = readFileSync("scripts/publish-opencanon-release.ts", "utf8");

  assert.match(source, /function waitForReleaseWorkflowRun/);
  assert.match(source, /git", \["rev-list", "-n", "1", tagName\]/);
  assert.match(source, /"workflow",\s*"run",\s*ReleaseWorkflow/s);
  assert.match(source, /"--ref",\s*tagName/s);
  assert.match(source, /`tag=\$\{tagName\}`/);
  assert.match(source, /previousRunIds/);
  assert.match(source, /run\.event === "workflow_dispatch"/);
  assert.match(source, /"--commit",\s*headSha/s);
  assert.match(source, /ReleaseRunWaitMs/);
  assert.match(source, /sleep\(ReleaseRunPollMs\)/);
  assert.match(source, /ReleaseBranch = "main"/);
  assert.match(source, /assertReleaseWorkspace\(\)/);
  assert.match(source, /assertTagAvailable\(tagName\)/);
  assert.match(source, /captureReleaseWorktree/);
  assert.match(source, /HTTP 404/);
  assert.match(source, /"push", "--atomic", "origin", ReleaseBranch, tagName/);
  assert(!source.includes("--no-check"));
  assert(!source.includes("--delete-existing"));
});

test("release workflow runs the full gate before publishing assets", () => {
  const workflow = readFileSync(".github/workflows/release.yml", "utf8");

  assert.match(workflow, /on:\s*\n\s*workflow_dispatch:/);
  assert(!/^\s{2}push:/m.test(workflow));
  assert.match(workflow, /concurrency:[\s\S]*group: release-\$\{\{ inputs\.tag \}\}/);
  assert.match(workflow, /ref: \$\{\{ github\.sha \}\}/);
  assert(!workflow.includes("ref: ${{ inputs.tag }}"));
  assert.match(workflow, /Verify release tag/);
  assert.match(workflow, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.match(workflow, /preflight:/);
  assert.match(workflow, /name: Release Preflight/);
  assert.match(workflow, /run: npm run check:ci/);
  assert.match(workflow, /build-engine:[\s\S]*needs:[\s\S]*- preflight/);
  assert.match(workflow, /publish-release:[\s\S]*needs:[\s\S]*- preflight[\s\S]*- build-engine/);
  assert.match(workflow, /Release \$tag already exists and is immutable/);
  assert(!workflow.includes("gh release edit"));
  assert(!workflow.includes("--clobber"));
});

test("every hosted action is pinned to a full commit", () => {
  const workflowDir = ".github/workflows";
  const unpinned = readdirSync(workflowDir)
    .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
    .flatMap((name) => {
      const source = readFileSync(path.join(workflowDir, name), "utf8");
      return source
        .split(/\r?\n/)
        .filter((line) => /^\s*uses:\s*[^.]/.test(line))
        .filter((line) => !/@[0-9a-f]{40}(?:\s+#.*)?$/.test(line))
        .map((line) => `${name}: ${line.trim()}`);
    });

  assert.deepEqual(unpinned, []);
});

test("release preparation updates package locks and every Rust package", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-release-versions-"));
  const write = (relativePath: string, contents: string) => {
    const target = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, contents);
  };
  const cargoLock = (packages: string[]) =>
    packages
      .map((name) => `[[package]]\nname = "${name}"\nversion = "0.1.0"\n`)
      .join("\n");

  try {
    write("package.json", JSON.stringify({ name: "fixture", version: "0.1.0" }, null, 2));
    write("packages/core/package.json", JSON.stringify({ name: "core", version: "0.1.0" }, null, 2));
    write(
      "package-lock.json",
      JSON.stringify(
        {
          name: "fixture",
          version: "0.1.0",
          lockfileVersion: 3,
          packages: {
            "": { name: "fixture", version: "0.1.0" },
            "packages/core": { name: "core", version: "0.1.0" },
          },
        },
        null,
        2,
      ),
    );
    for (const crate of ["opencanon-engine", "opencanon-inference", "opencanon-vector"]) {
      write(`crates/${crate}/Cargo.toml`, `[package]\nname = "${crate}"\nversion = "0.1.0"\n`);
    }
    write("crates/opencanon-engine/Cargo.lock", cargoLock(["opencanon-engine", "opencanon-inference", "opencanon-vector"]));
    write("crates/opencanon-inference/Cargo.lock", cargoLock(["opencanon-inference"]));
    write("crates/opencanon-vector/Cargo.lock", cargoLock(["opencanon-vector"]));
    write("crates/opencanon-engine/src/constants.rs", 'pub const ENGINE_VERSION: &str = "0.1.0";\n');
    write("README.md", '{ "runtimeVersion": "0.1.0" }\n');
    write("CHANGELOG.md", "# Changelog\n\n## v1.2.3\n\n- Authored release notes.\n\n## v0.1.0\n\n- Existing.\n");

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/prepare-opencanon-release.ts"), "1.2.3"],
      { cwd: rootDir, encoding: "utf8" },
    );
    assert.equal(result.status, 0, result.stderr);
    const packageLock = JSON.parse(readFileSync(path.join(rootDir, "package-lock.json"), "utf8")) as {
      version: string;
      packages: Record<string, { version: string }>;
    };
    assert.equal(packageLock.version, "1.2.3");
    assert.equal(packageLock.packages[""].version, "1.2.3");
    assert.equal(packageLock.packages["packages/core"].version, "1.2.3");
    for (const crate of ["opencanon-engine", "opencanon-inference", "opencanon-vector"]) {
      assert.match(readFileSync(path.join(rootDir, `crates/${crate}/Cargo.toml`), "utf8"), /version = "1\.2\.3"/);
    }
    assert(!readFileSync(path.join(rootDir, "crates/opencanon-engine/Cargo.lock"), "utf8").includes('version = "0.1.0"'));
    assert.match(readFileSync(path.join(rootDir, "CHANGELOG.md"), "utf8"), /Authored release notes/);

    const missingNotes = spawnSync(
      process.execPath,
      [path.resolve("scripts/prepare-opencanon-release.ts"), "2.0.0"],
      { cwd: rootDir, encoding: "utf8" },
    );
    assert.notEqual(missingNotes.status, 0);
    assert.match(missingNotes.stderr, /must contain an authored v2\.0\.0 heading/);
    assert.equal(
      (JSON.parse(readFileSync(path.join(rootDir, "package.json"), "utf8")) as { version: string }).version,
      "1.2.3",
      "missing release notes must fail before mutating versions",
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("local and hosted gates audit every committed Rust lockfile", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const audit = packageJson.scripts?.["security:audit:rust"] ?? "";
  const ci = readFileSync(".github/workflows/ci.yml", "utf8");
  const release = readFileSync(".github/workflows/release.yml", "utf8");

  for (const lockfile of [
    "crates/opencanon-engine/Cargo.lock",
    "crates/opencanon-inference/Cargo.lock",
    "crates/opencanon-vector/Cargo.lock",
  ]) {
    assert(audit.includes(`cargo audit --file ${lockfile} --deny unsound`));
  }
  assert.equal(packageJson.scripts?.["security:audit"], "npm run security:audit:npm && npm run security:audit:rust");
  assert.equal(packageJson.scripts?.["security:audit:npm"], "npm audit --omit=dev --audit-level=high");
  assert.match(ci, /cargo \+1\.95\.0 install cargo-audit --version 0\.22\.2 --locked/);
  assert.match(release, /cargo \+1\.95\.0 install cargo-audit --version 0\.22\.2 --locked/);
});

test("native embedding smoke is required unless explicitly optional", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const source = readFileSync("scripts/native-embedding-smoke.ts", "utf8");

  assert.match(expandedScript(packageJson, ["check:ci", "check:ci:quality"]), /npm run smoke:native-embedding/);
  assert.equal(packageJson.scripts?.["smoke:native-embedding"], "node scripts/native-embedding-smoke.ts");
  assert.equal(packageJson.scripts?.["smoke:native-embedding:optional"], "node scripts/native-embedding-smoke.ts --optional");
  assert.match(source, /process\.argv\.includes\("--optional"\)/);
  assert(!source.includes("OPENCANON_NATIVE_EMBEDDING_SMOKE"));
});

test("CI quality includes TypeScript contract checking", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };

  assert.match(packageJson.scripts?.["check:ci:quality"] ?? "", /npm run check:types/);
});

test("CI separates fixture checks from required project producers", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const checkCi = expandedScript(packageJson, ["check:ci", "check:ci:quality"]);

  assert.match(checkCi, /validate --check-fixtures(?:\s|&&)/);
  assert.doesNotMatch(checkCi, /validate --check-fixtures --require-producer/);
  assert.match(checkCi, /validate --project --require-producer typescript/);
});

test("CI relies on doctor for managed skill drift instead of retired launcher paths", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const releaseCheck = readFileSync("scripts/check-release-consistency.ts", "utf8");

  assert.match(workflow, /npm run check:ci:quality/);
  assert.match(workflow, /npm run test:runtime-integration/);
  assert(!workflow.includes("opencanon.mjs"));
  assert(!workflow.includes(".agents/skills/opencanon/scripts/opencanon.mjs"));
  assert.match(releaseCheck, /build:skill-runtime/);
});

test("release manifest requires a generated OpenCanon runtime", () => {
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
      /Missing generated OpenCanon runtime/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("release manifest can require every engine target", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-release-missing-"));
  const runtimeDir = path.join(rootDir, "runtime");
  try {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(path.join(runtimeDir, "cli.js"), "export const runtime = true;\n");
    assert.throws(
      () =>
        createOpenCanonRelease({
          assetDir: rootDir,
          outDir: path.join(rootDir, "dist"),
          requireAll: true,
          runtimeDir,
        }),
      /Missing engine release assets/,
    );
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});
