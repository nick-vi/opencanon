#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const version = process.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: npm run release:prepare -- <semver>");
}

const releaseDate = new Date().toISOString().slice(0, 10);
const tag = `v${version}`;
const packagePaths = [
  "package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/distribution/package.json",
  "packages/runtime/package.json",
  "packages/engine/package.json",
  "packages/validators/package.json",
];
const rustPackagePath = "crates/opencanon-engine/Cargo.toml";
const rustLockPath = "crates/opencanon-engine/Cargo.lock";
const engineConstantsPath = "crates/opencanon-engine/src/constants.rs";

for (const packagePath of packagePaths) {
  updateJson(packagePath, (json) => {
    json.version = version;
  });
}

replaceInFile(rustPackagePath, /^version = "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"$/m, `version = "${version}"`);
replaceInFile(engineConstantsPath, /ENGINE_VERSION: &str = "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"/, `ENGINE_VERSION: &str = "${version}"`);
replaceRustLockPackageVersion(rustLockPath, "opencanon-engine", version);

replaceInFile(
  "README.md",
  /"runtimeVersion": "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"/g,
  `"runtimeVersion": "${version}"`,
);

updateChangelog(`v${version}`, releaseDate);
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
  if (after === before) throw new Error(`No release version reference updated in ${relativePath}.`);
  writeFileSync(filePath, after);
}

function updateChangelog(tagName: string, date: string): void {
  const changelogPath = path.join(rootDir, "CHANGELOG.md");
  const changelog = existsSync(changelogPath) ? readFileSync(changelogPath, "utf8") : "# Changelog\n";
  // Anchor to a heading line so an unrelated mention of the tag in prose can't suppress
  // the real changelog entry.
  if (new RegExp(`^## ${RegExp.escape(tagName)}\\b`, "m").test(changelog)) return;

  const heading = `## ${tagName} - ${date}`;
  const entry = [
    heading,
    "",
    "- Added scoped graph search and symbol-kind filtering for repository queries.",
    "- Added graph-backed migration and unused-export validation improvements.",
    "- Added refactor planning APIs and refreshed release/runtime documentation.",
    "",
    "",
  ].join("\n");

  if (changelog.startsWith("# Changelog\n\n")) {
    writeFileSync(changelogPath, changelog.replace("# Changelog\n\n", `# Changelog\n\n${entry}`));
    return;
  }

  writeFileSync(changelogPath, `# Changelog\n\n${entry}${changelog.replace(/^# Changelog\n?/, "")}`);
}

function replaceRustLockPackageVersion(relativePath: string, packageName: string, nextVersion: string): void {
  const filePath = path.join(rootDir, relativePath);
  const before = readFileSync(filePath, "utf8");
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${RegExp.escape(packageName)}"\\nversion = ")\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(")`);
  const after = before.replace(pattern, `$1${nextVersion}$2`);
  if (after === before) throw new Error(`No Cargo.lock version entry updated for ${packageName}.`);
  writeFileSync(filePath, after);
}
