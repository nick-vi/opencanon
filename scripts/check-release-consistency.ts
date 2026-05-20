import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPaths = [
  "package.json",
  "apps/site/package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/daemon/package.json",
  "packages/engine/package.json",
  "packages/ui/package.json",
  "packages/validators/package.json",
];

const versionPattern = "\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?";

type Check = {
  label: string;
  value: string | null;
};

const checks: Check[] = packageJsonPaths.map((relativePath) => ({
  label: `${relativePath} version`,
  value: readJson(relativePath).version,
}));

const expectedVersion = checks[0]?.value;
if (!expectedVersion) fail(["package.json version is missing."]);

checks.push(
  {
    label: "crates/opencanon-engine/Cargo.toml version",
    value: matchFile("crates/opencanon-engine/Cargo.toml", new RegExp(`^version = "(${versionPattern})"$`, "m")),
  },
  {
    label: "crates/opencanon-engine/Cargo.lock opencanon-engine version",
    value: matchFile("crates/opencanon-engine/Cargo.lock", new RegExp(`\\[\\[package\\]\\]\\nname = "opencanon-engine"\\nversion = "(${versionPattern})"`)),
  },
  {
    label: "crates/opencanon-engine/src/constants.rs ENGINE_VERSION",
    value: matchFile("crates/opencanon-engine/src/constants.rs", new RegExp(`ENGINE_VERSION: &str = "(${versionPattern})"`)),
  },
  {
    label: "README.md skillVersion",
    value: matchFile("README.md", new RegExp(`"skillVersion": "(${versionPattern})"`)),
  },
  {
    label: ".agents/skills/opencanon/scripts/opencanon.ts manifest version",
    value: manifestVersion(".agents/skills/opencanon/scripts/opencanon.ts"),
  },
  {
    label: "apps/site/src/lib/site.config.js manifest version",
    value: manifestVersion("apps/site/src/lib/site.config.js"),
  },
  {
    label: "CHANGELOG.md latest heading",
    value: matchFile("CHANGELOG.md", new RegExp(`^## v?(${versionPattern})\\b`, "m")),
  },
);

const failures = checks.flatMap((check) => {
  if (!check.value) return [`${check.label} is missing.`];
  if (check.value !== expectedVersion) return [`${check.label} is ${check.value}, expected ${expectedVersion}.`];
  return [];
});

if (failures.length > 0) fail(failures);
console.log(`Release consistency check passed for ${expectedVersion}.`);

function readJson(relativePath: string): Record<string, any> {
  return JSON.parse(read(relativePath)) as Record<string, any>;
}

function read(relativePath: string): string {
  const filePath = path.join(rootDir, relativePath);
  if (!existsSync(filePath)) fail([`${relativePath} does not exist.`]);
  return readFileSync(filePath, "utf8");
}

function matchFile(relativePath: string, pattern: RegExp): string | null {
  return pattern.exec(read(relativePath))?.[1] ?? null;
}

function manifestVersion(relativePath: string): string | null {
  return matchFile(relativePath, new RegExp(`/releases/download/v(${versionPattern})/opencanon-runtime-manifest\\.json`));
}

function fail(messages: string[]): never {
  console.error("Release consistency check failed:");
  for (const message of messages) console.error(`- ${message}`);
  process.exit(1);
}
