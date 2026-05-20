#!/usr/bin/env bun
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const rootDir = process.cwd();
const version = Bun.argv[2];

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: bun run release:prepare -- <semver>");
}

const tag = `v${version}`;
const releaseDate = new Date().toISOString().slice(0, 10);
const packagePaths = [
  "package.json",
  "apps/site/package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/daemon/package.json",
  "packages/engine/package.json",
  "packages/ui/package.json",
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
  ".agents/skills/opencanon/scripts/opencanon.ts",
  /releases\/download\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\/opencanon-runtime-manifest\.json/g,
  `releases/download/${tag}/opencanon-runtime-manifest.json`,
);

replaceInFile(
  "apps/site/src/lib/site.config.js",
  /releases\/download\/v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\/opencanon-runtime-manifest\.json/g,
  `releases/download/${tag}/opencanon-runtime-manifest.json`,
);

replaceInFile(
  "README.md",
  /"skillVersion": "\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?"/g,
  `"skillVersion": "${version}"`,
);

updateChangelog(tag, releaseDate);
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
  if (changelog.includes(`## ${tagName} `) || changelog.includes(`## ${tagName}\n`)) return;

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
  const pattern = new RegExp(`(\\[\\[package\\]\\]\\nname = "${escapeRegExp(packageName)}"\\nversion = ")\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(")`);
  const after = before.replace(pattern, `$1${nextVersion}$2`);
  if (after === before) throw new Error(`No Cargo.lock version entry updated for ${packageName}.`);
  writeFileSync(filePath, after);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
