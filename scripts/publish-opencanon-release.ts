#!/usr/bin/env bun
import { spawnSync } from "node:child_process";

type Options = {
  check: boolean;
  commit: boolean;
  deleteExisting: boolean;
  push: boolean;
  tag: boolean;
  verify: boolean;
  watch: boolean;
};

const version = Bun.argv[2];
const args = Bun.argv.slice(3);

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: bun run release:publish -- <semver> [--no-check] [--no-commit] [--no-tag] [--no-push] [--delete-existing] [--no-watch] [--no-verify]");
}

const options = parseOptions(args);
const tagName = `v${version}`;

run("bun", ["run", "release:prepare", "--", version]);
if (options.check) run("bun", ["run", "check:ci"]);

if (options.commit) {
  run("git", ["add", "-A"]);
  run("git", ["commit", "-m", `chore(release): prepare ${tagName}`]);
}

if (options.deleteExisting) {
  run("gh", ["release", "delete", tagName, "--yes", "--cleanup-tag"], { optional: true });
  run("git", ["tag", "-d", tagName], { optional: true });
}

if (options.tag) {
  run("git", ["tag", "-a", tagName, "-m", tagName]);
}

if (options.push) {
  run("git", ["push", "origin", "HEAD"]);
  run("git", ["push", "origin", tagName]);
}

if (options.watch) {
  const runId = output("gh", [
    "run",
    "list",
    "--repo",
    "nick-vi/opencanon",
    "--workflow",
    "release.yml",
    "--branch",
    tagName,
    "--limit",
    "1",
    "--json",
    "databaseId",
    "--jq",
    ".[0].databaseId",
  ]);
  if (!runId) throw new Error(`No release workflow run found for ${tagName}.`);
  run("gh", ["run", "watch", runId, "--repo", "nick-vi/opencanon", "--exit-status", "--compact"]);
}

if (options.verify) {
  const requiredAssets = [
    "opencanon-runtime-manifest.json",
    "latest.json",
    "stable.json",
    "SHA256SUMS",
    "opencanon-skill-runtime.tar.gz",
    "opencanon.darwin-arm64.node",
    "opencanon.darwin-x64.node",
    "opencanon.linux-arm64-gnu.node",
    "opencanon.linux-x64-gnu.node",
    "opencanon.win32-x64-msvc.node",
  ];
  const assets = output("gh", ["release", "view", tagName, "--json", "assets", "--jq", ".assets[].name"]);
  const assetNames = new Set(assets.split("\n").filter(Boolean));
  const missing = requiredAssets.filter((asset) => !assetNames.has(asset));
  if (missing.length > 0) {
    throw new Error(`Release ${tagName} is missing assets: ${missing.join(", ")}`);
  }
}

console.log(`Published OpenCanon ${tagName}.`);

function parseOptions(values: string[]): Options {
  const options: Options = {
    check: true,
    commit: true,
    deleteExisting: false,
    push: true,
    tag: true,
    verify: true,
    watch: true,
  };

  for (const value of values) {
    if (value === "--no-check") options.check = false;
    else if (value === "--no-commit") options.commit = false;
    else if (value === "--delete-existing") options.deleteExisting = true;
    else if (value === "--no-push") options.push = false;
    else if (value === "--no-tag") options.tag = false;
    else if (value === "--no-watch") options.watch = false;
    else if (value === "--no-verify") options.verify = false;
    else throw new Error(`Unknown release option: ${value}`);
  }

  return options;
}

function run(command: string, args: string[], options: { optional?: boolean } = {}): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status === 0) return;
  if (options.optional) return;
  throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function output(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}
