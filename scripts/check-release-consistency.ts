import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJsonPaths = [
  "package.json",
  "packages/cli/package.json",
  "packages/core/package.json",
  "packages/distribution/package.json",
  "packages/runtime/package.json",
  "packages/engine/package.json",
  "packages/validators/package.json",
  "apps/site/package.json",
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
    label: "crates/opencanon-inference/Cargo.toml version",
    value: matchFile("crates/opencanon-inference/Cargo.toml", new RegExp(`^version = "(${versionPattern})"$`, "m")),
  },
  {
    label: "crates/opencanon-inference/Cargo.lock opencanon-inference version",
    value: matchFile("crates/opencanon-inference/Cargo.lock", new RegExp(`\\[\\[package\\]\\]\\nname = "opencanon-inference"\\nversion = "(${versionPattern})"`)),
  },
  {
    label: "crates/opencanon-engine/Cargo.lock opencanon-inference version",
    value: matchFile("crates/opencanon-engine/Cargo.lock", new RegExp(`\\[\\[package\\]\\]\\nname = "opencanon-inference"\\nversion = "(${versionPattern})"`)),
  },
  {
    label: "README.md runtimeVersion",
    value: matchFile("README.md", new RegExp(`"runtimeVersion": "(${versionPattern})"`)),
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
assertFactExtractorVersionLockstep();
assertReleaseWorkflowRuntimePackaging();
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

function assertReleaseWorkflowRuntimePackaging(): void {
  const required = [
    [".github/workflows/release.yml", "npm run build:runtime -- --skip-engine"],
    [".github/workflows/release.yml", "--require-runtime"],
    [".github/workflows/release.yml", "--runtime-version"],
    ["scripts/create-opencanon-release.ts", "renderInstallerAsset"],
    ["scripts/opencanon-install.mjs", "OPENCANON_TRUSTED_RELEASE_KEYS"],
    ["scripts/publish-opencanon-release.ts", "opencanon-install.mjs"],
    ["scripts/publish-opencanon-release.ts", "opencanon-runtime-darwin-arm64.tar.gz"],
    ["scripts/publish-opencanon-release.ts", "opencanon-runtime-linux-x64.tar.gz"],
    ["scripts/publish-opencanon-release.ts", "opencanon-runtime-win32-x64.tar.gz"],
  ] as const;
  const missing = required
    .filter(([relativePath, text]) => !read(relativePath).includes(text))
    .map(([relativePath, text]) => `${relativePath} must include ${text}.`);
  const forbidden = [
    [".github/workflows/release.yml", "build-app"],
    [".github/workflows/release.yml", "app-dir"],
    [".github/workflows/release.yml", "--require-app"],
    [".github/workflows/release.yml", "Download app bundles"],
    [".github/workflows/release.yml", "npm run ui:build"],
    [".github/workflows/release.yml", "@opencanon/desktop"],
    [".github/workflows/release.yml", "package-opencanon-app"],
    ["package.json", "desktop:package"],
    ["package.json", "ui:build"],
    [".github/workflows/release.yml", "build:skill-runtime"],
    [".github/workflows/release.yml", "--skill-version"],
    ["scripts/publish-opencanon-release.ts", "opencanon-app-darwin-arm64.tar.gz"],
    ["scripts/publish-opencanon-release.ts", "opencanon-app-darwin-x64.tar.gz"],
    ["scripts/publish-opencanon-release.ts", "opencanon-app-linux-arm64.tar.gz"],
    ["scripts/publish-opencanon-release.ts", "opencanon-app-linux-x64.tar.gz"],
    ["scripts/publish-opencanon-release.ts", "opencanon-app-win32-x64.tar.gz"],
    ["scripts/publish-opencanon-release.ts", "opencanon-skill-runtime.tar.gz"],
    ["scripts/publish-opencanon-release.ts", "opencanon.darwin-arm64.node"],
  ] as const;
  const stale = forbidden
    .filter(([relativePath, text]) => read(relativePath).includes(text))
    .map(([relativePath, text]) => `${relativePath} must not include stale runtime asset text ${text}.`);
  if (missing.length > 0 || stale.length > 0) fail([...missing, ...stale]);
}

// The validator fact cache (packages/core/src/cache.ts `factCacheVersion`) gates
// fact-cache validity and MUST equal the engine's EXTRACTOR_VERSION, so a cache
// written by an older fact extractor invalidates on upgrade. They are in separate
// files/languages; enforce the coupling here so a future engine bump can't
// silently leave stale facts being served.
function assertFactExtractorVersionLockstep(): void {
  const cacheVersion = matchFile("packages/core/src/cache.ts", /const factCacheVersion = "([^"]+)"/);
  const extractorVersion = matchFile("crates/opencanon-engine/src/constants.rs", /EXTRACTOR_VERSION: &str = "([^"]+)"/);
  if (!cacheVersion || !extractorVersion) {
    fail(["Could not read cache.ts factCacheVersion / engine EXTRACTOR_VERSION for the lockstep check."]);
  }
  if (cacheVersion !== extractorVersion) {
    fail([
      `packages/core/src/cache.ts factCacheVersion (${cacheVersion}) must equal engine EXTRACTOR_VERSION (${extractorVersion}). ` +
        "Bump them together — otherwise a pre-existing analysis.json keeps serving facts from the old extractor.",
    ]);
  }

  // The language registry advertises an extractorVersion per fact-producing language; these
  // must also track the engine so the published capability metadata can't drift (the bug a
  // prior bump left behind because nothing checked it here).
  const registry = read("packages/core/src/language-registry.ts");
  const advertised = [...registry.matchAll(/extractorVersion:\s*"(engine-graph-[^"]+)"/g)].map((match) => match[1]);
  const mismatched = [...new Set(advertised)].filter((version) => version !== extractorVersion);
  if (mismatched.length > 0) {
    fail([
      `packages/core/src/language-registry.ts advertises extractorVersion ${mismatched.join(", ")} but the engine EXTRACTOR_VERSION is ${extractorVersion}. ` +
        "Update the registry's engine-graph-* strings to match.",
    ]);
  }
}

function fail(messages: string[]): never {
  console.error("Release consistency check failed:");
  for (const message of messages) console.error(`- ${message}`);
  process.exit(1);
}
