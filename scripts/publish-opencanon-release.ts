#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const ReleaseRepo = "nick-vi/opencanon";
const ReleaseWorkflow = "release.yml";
const ReleaseRunWaitMs = 180_000;
const ReleaseRunPollMs = 5_000;

type WorkflowRun = {
  databaseId: number;
  event: string;
  headBranch: string;
  headSha: string;
  status: string;
  url: string;
};

type Options = {
  check: boolean;
  commit: boolean;
  deleteExisting: boolean;
  push: boolean;
  tag: boolean;
  verify: boolean;
  watch: boolean;
};

const version = process.argv[2];
const args = process.argv.slice(3);

if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Usage: npm run release:publish -- <semver> [--no-check] [--no-commit] [--no-tag] [--no-push] [--delete-existing] [--no-watch] [--no-verify]");
}

const options = parseOptions(args);
const tagName = `v${version}`;

run("npm", ["run", "release:prepare", "--", version]);
if (options.check) run("npm", ["run", "check:ci"]);

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
  const headSha = output("git", ["rev-list", "-n", "1", tagName]);
  const runId = waitForReleaseWorkflowRun(tagName, headSha);
  run("gh", ["run", "watch", runId, "--repo", ReleaseRepo, "--exit-status", "--compact"]);
}

if (options.verify) {
  const requiredAssets = [
    "opencanon-runtime-manifest.json",
    "latest.json",
    "stable.json",
    "SHA256SUMS",
    "opencanon-install.mjs",
    "opencanon-runtime-darwin-arm64.tar.gz",
    "opencanon-runtime-darwin-x64.tar.gz",
    "opencanon-runtime-linux-arm64.tar.gz",
    "opencanon-runtime-linux-x64.tar.gz",
    "opencanon-runtime-win32-x64.tar.gz",
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

function waitForReleaseWorkflowRun(tagName: string, headSha: string): string {
  const startedAt = Date.now();
  let lastRuns: WorkflowRun[] = [];

  while (Date.now() - startedAt < ReleaseRunWaitMs) {
    const runs = listReleaseWorkflowRuns(headSha);
    lastRuns = runs;
    const match = runs.find((run) => run.event === "push" && run.headSha === headSha && (run.headBranch === tagName || run.headBranch === ""));
    if (match) return String(match.databaseId);
    sleep(ReleaseRunPollMs);
  }

  throw new Error(
    [
      `No release workflow run found for ${tagName} (${headSha}) within ${Math.round(ReleaseRunWaitMs / 1000)}s.`,
      `Last runs: ${JSON.stringify(lastRuns, null, 2)}`,
    ].join("\n"),
  );
}

function listReleaseWorkflowRuns(headSha: string): WorkflowRun[] {
  const raw = output("gh", [
    "run",
    "list",
    "--repo",
    ReleaseRepo,
    "--workflow",
    ReleaseWorkflow,
    "--event",
    "push",
    "--commit",
    headSha,
    "--limit",
    "20",
    "--json",
    "databaseId,event,headBranch,headSha,status,url",
  ]);
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter(isWorkflowRun) : [];
  } catch (error) {
    throw new Error(`Could not parse gh run list output: ${error instanceof Error ? error.message : String(error)}\n${raw}`);
  }
}

function isWorkflowRun(value: unknown): value is WorkflowRun {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const run = value as Record<string, unknown>;
  return (
    typeof run.databaseId === "number" &&
    typeof run.event === "string" &&
    typeof run.headBranch === "string" &&
    typeof run.headSha === "string" &&
    typeof run.status === "string" &&
    typeof run.url === "string"
  );
}

function sleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}
