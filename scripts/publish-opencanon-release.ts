#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const ReleaseRepo = "nick-vi/opencanon";
const ReleaseWorkflow = "release.yml";
const ReleaseBranch = "main";
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

const version = process.argv[2];
const args = process.argv.slice(3);

if (
  !version ||
  !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version) ||
  args.length > 0
) {
  throw new Error("Usage: npm run release:publish -- <semver>");
}

const tagName = `v${version}`;
assertReleaseWorkspace();
assertTagAvailable(tagName);

run("npm", ["run", "release:prepare", "--", version]);
const preparedWorktree = captureReleaseWorktree();
if (!preparedWorktree.status) {
  throw new Error(`Release preparation produced no changes for ${tagName}.`);
}
if (preparedWorktree.status.split("\n").some((line) => line.startsWith("?? "))) {
  throw new Error(
    `Release preparation produced untracked files, which are outside the version inventory:\n${preparedWorktree.status}`,
  );
}
run("npm", ["run", "check:ci"]);
const verifiedWorktree = captureReleaseWorktree();
if (
  verifiedWorktree.status !== preparedWorktree.status ||
  verifiedWorktree.diff !== preparedWorktree.diff
) {
  throw new Error(
    "The release gate changed tracked or untracked source files. Review those changes and rerun from a clean worktree.",
  );
}
run("git", ["add", "-A"]);
run("git", ["commit", "-m", `chore(release): prepare ${tagName}`]);
run("git", ["tag", "-a", tagName, "-m", tagName]);
run("git", ["push", "--atomic", "origin", ReleaseBranch, tagName]);

const headSha = output("git", ["rev-list", "-n", "1", tagName]);
const previousRunIds = new Set(
  listReleaseWorkflowRuns(headSha).map((run) => run.databaseId),
);
run("gh", [
  "workflow",
  "run",
  ReleaseWorkflow,
  "--repo",
  ReleaseRepo,
  "--ref",
  tagName,
  "--field",
  `tag=${tagName}`,
]);
const runId = waitForReleaseWorkflowRun(tagName, headSha, previousRunIds);
run("gh", [
  "run",
  "watch",
  runId,
  "--repo",
  ReleaseRepo,
  "--exit-status",
  "--compact",
]);
verifyReleaseAssets(tagName);

console.log(`Published OpenCanon ${tagName}.`);

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.status === 0) return;
  throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status ?? "unknown"}.`);
}

function output(command: string, args: string[]): string {
  const result = spawnSync(command, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function assertReleaseWorkspace(): void {
  const branch = output("git", ["branch", "--show-current"]);
  if (branch !== ReleaseBranch) {
    throw new Error(
      `Release publication requires branch ${ReleaseBranch}; current branch is ${branch || "detached"}.`,
    );
  }
  const status = output("git", ["status", "--porcelain"]);
  if (status) {
    throw new Error(
      `Release publication requires a clean worktree before version preparation:\n${status}`,
    );
  }
}

function assertTagAvailable(tagName: string): void {
  const localTag = spawnSync("git", ["rev-parse", "--verify", `refs/tags/${tagName}`], {
    encoding: "utf8",
  });
  if (localTag.status === 0) {
    throw new Error(`Release tag ${tagName} already exists locally.`);
  }
  if (localTag.status !== 128) {
    throw new Error(`Could not inspect local release tags:\n${localTag.stderr}`);
  }

  const remoteTag = spawnSync(
    "git",
    ["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tagName}`],
    { encoding: "utf8" },
  );
  if (remoteTag.status === 0) {
    throw new Error(`Release tag ${tagName} already exists on origin.`);
  }
  if (remoteTag.status !== 2) {
    throw new Error(`Could not inspect origin release tags:\n${remoteTag.stderr}`);
  }

  const release = spawnSync(
    "gh",
    ["api", `repos/${ReleaseRepo}/releases/tags/${tagName}`, "--silent"],
    { encoding: "utf8" },
  );
  if (release.status === 0) {
    throw new Error(`GitHub release ${tagName} already exists.`);
  }
  if (!/HTTP 404/i.test(release.stderr)) {
    throw new Error(`Could not inspect GitHub releases:\n${release.stderr}`);
  }
}

function captureReleaseWorktree(): { diff: string; status: string } {
  return {
    status: output("git", ["status", "--porcelain=v1", "--untracked-files=all"]),
    diff: output("git", ["diff", "--no-ext-diff", "--binary"]),
  };
}

function waitForReleaseWorkflowRun(
  tagName: string,
  headSha: string,
  previousRunIds: ReadonlySet<number>,
): string {
  const startedAt = Date.now();
  let lastRuns: WorkflowRun[] = [];

  while (Date.now() - startedAt < ReleaseRunWaitMs) {
    const runs = listReleaseWorkflowRuns(headSha);
    lastRuns = runs;
    const match = runs.find(
      (run) =>
        run.event === "workflow_dispatch" &&
        run.headSha === headSha &&
        !previousRunIds.has(run.databaseId),
    );
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
    "workflow_dispatch",
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

function verifyReleaseAssets(tagName: string): void {
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
  const assets = output("gh", [
    "release",
    "view",
    tagName,
    "--json",
    "assets",
    "--jq",
    ".assets[].name",
  ]);
  const assetNames = new Set(assets.split("\n").filter(Boolean));
  const missing = requiredAssets.filter((asset) => !assetNames.has(asset));
  if (missing.length > 0) {
    throw new Error(`Release ${tagName} is missing assets: ${missing.join(", ")}`);
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
