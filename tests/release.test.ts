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

test("test:tree includes every repo test file", () => {
  const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["test:tree"] ?? "";
  const missing = TestTreeCoverageRoots.flatMap((root) => collectTestFiles(root))
    .sort()
    .filter((filePath) => !isCoveredByTestTree(script, filePath));

  assert.deepEqual(missing, []);
});

test("repo tracks managed OpenCanon skill artifacts required by doctor", () => {
  const untracked = OpenCanonSkillArtifacts.map((artifact) => artifact.path).filter(
    (artifactPath) => spawnSync("git", ["ls-files", "--error-unmatch", "--", artifactPath], { encoding: "utf8" }).status !== 0,
  );

  assert.deepEqual(untracked, []);
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

test("release publish watches the tag workflow by commit with backoff", () => {
  const source = readFileSync("scripts/publish-opencanon-release.ts", "utf8");

  assert.match(source, /function waitForReleaseWorkflowRun/);
  assert.match(source, /git", \["rev-list", "-n", "1", tagName\]/);
  assert.match(source, /"--commit",\s*headSha/s);
  assert.match(source, /ReleaseRunWaitMs/);
  assert.match(source, /sleep\(ReleaseRunPollMs\)/);
  assert(!source.includes('"--branch",\n    tagName'));
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
