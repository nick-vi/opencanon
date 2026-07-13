#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import {
  packageLockWorkspaceKey,
  releasePackageJsonPaths,
  ReleaseRustPackages,
} from "./release-version-files.ts";

const rootDir = process.cwd();
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: npm run release:prepare -- <semver>");
}

const tag = `v${version}`;
const packagePaths = releasePackageJsonPaths(rootDir);
const engineConstantsPath = "crates/opencanon-engine/src/constants.rs";

assertChangelogEntry(tag);

for (const packagePath of packagePaths) {
  updateJson(packagePath, (json) => {
    json.version = version;
  });
}

updateJson("package-lock.json", (json) => {
  json.version = version;
  const packages = json.packages;
  if (!packages || typeof packages !== "object" || Array.isArray(packages)) {
    throw new Error("package-lock.json packages map is missing.");
  }
  const workspaces = packages as Record<string, unknown>;
  for (const packagePath of packagePaths) {
    const workspaceKey = packageLockWorkspaceKey(packagePath);
    const workspace = workspaces[workspaceKey];
    if (!workspace || typeof workspace !== "object" || Array.isArray(workspace)) {
      throw new Error(`package-lock.json workspace ${JSON.stringify(workspaceKey)} is missing.`);
    }
    (workspace as Record<string, unknown>).version = version;
  }
});

for (const rustPackage of ReleaseRustPackages) {
  replaceInFile(
    rustPackage.manifestPath,
    /^version = "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"$/m,
    `version = "${version}"`,
  );
  for (const lockPath of rustPackage.lockPaths) {
    replaceRustLockPackageVersion(lockPath, rustPackage.name, version);
  }
}
replaceInFile(engineConstantsPath, /ENGINE_VERSION: &str = "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"/, `ENGINE_VERSION: &str = "${version}"`);

replaceInFile(
  "README.md",
  /"runtimeVersion": "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"/g,
  `"runtimeVersion": "${version}"`,
);

console.log(`Prepared OpenCanon ${tag}.`);

function updateJson(relativePath: string, update: (json: Record<string, unknown>) => void): void {
  const filePath = path.join(rootDir, relativePath);
  const json = JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  update(json);
  writeFileSync(filePath, `${JSON.stringify(json, null, 2)}\n`);
}

function replaceInFile(relativePath: string, pattern: RegExp, replacement: string): void {
  const filePath = path.join(rootDir, relativePath);
  const before = readFileSync(filePath, "utf8");
  const after = before.replace(pattern, replacement);
  if (after === before && !before.includes(replacement)) throw new Error(`No release version reference updated in ${relativePath}.`);
  writeFileSync(filePath, after);
}

function assertChangelogEntry(tagName: string): void {
  const changelogPath = path.join(rootDir, "CHANGELOG.md");
  let changelog: string;
  try {
    changelog = readFileSync(changelogPath, "utf8");
  } catch (error) {
    throw new Error(
      `CHANGELOG.md must contain an authored ${tagName} heading before release preparation: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const heading = new RegExp(
    `^## (?:\\[)?${RegExp.escape(tagName)}(?:\\])?(?:\\s|$)`,
    "m",
  );
  if (!heading.test(changelog)) {
    throw new Error(
      `CHANGELOG.md must contain an authored ${tagName} heading before release preparation. Release tooling does not generate release notes.`,
    );
  }
}

function replaceRustLockPackageVersion(relativePath: string, packageName: string, nextVersion: string): void {
  const filePath = path.join(rootDir, relativePath);
  const before = readFileSync(filePath, "utf8");
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${RegExp.escape(packageName)}"\\nversion = ")\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(")`);
  const after = before.replace(pattern, `$1${nextVersion}$2`);
  if (after === before) {
    const alreadyUpdated = new RegExp(`\\[\\[package\\]\\]\\nname = "${RegExp.escape(packageName)}"\\nversion = "${RegExp.escape(nextVersion)}"`).test(before);
    if (!alreadyUpdated) throw new Error(`No Cargo.lock version entry updated for ${packageName}.`);
    return;
  }
  writeFileSync(filePath, after);
}
