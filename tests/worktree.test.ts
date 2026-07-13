import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "vitest";
import { createAuthoringProject } from "../packages/runtime/test/support.ts";

const script = path.join(process.cwd(), "packages/cli/src/index.ts");

test("shared Activity filters before bounding repository events", () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-worktree-activity-"));
  const worktreeDb = path.join(rootDir, ".opencanon", "worktrees-test.sqlite");
  const coordinationModule = pathToFileURL(path.join(process.cwd(), "packages/runtime/src/worktree-coordination.ts")).href;
  try {
    const child = spawnSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        [
          `import { DatabaseSync } from "node:sqlite";`,
          `import { writeGlobalCanonEvent, listGlobalCanonEvents } from ${JSON.stringify(coordinationModule)};`,
          `const rootDir = ${JSON.stringify(rootDir)};`,
          `const dbPath = ${JSON.stringify(worktreeDb)};`,
          `writeGlobalCanonEvent(rootDir, { id: "target", type: "updated", timestamp: "2026-07-12T00:00:00.000Z", files: [], changeIds: ["target-change"], taskIds: [], checkIds: [], conventionIds: [], validatorIds: [], findingIds: [], summary: "Target update." });`,
          `const db = new DatabaseSync(dbPath);`,
          `const repoKey = db.prepare("select repo_key from activity_events where id = 'target'").get().repo_key;`,
          `const insert = db.prepare("insert into activity_events(id, repo_key, timestamp, event_json, created_at) values (?, ?, ?, ?, ?)");`,
          `const insertLink = db.prepare("insert into activity_event_links(repo_key, event_id, kind, value) values (?, ?, 'change', ?)");`,
          `for (let index = 0; index < 600; index += 1) { const id = "unrelated-" + String(index).padStart(4, "0"); const event = { id, type: "updated", timestamp: "2026-07-12T00:00:01.000Z", files: [], changeIds: ["unrelated-change"], taskIds: [], checkIds: [], conventionIds: [], validatorIds: [], findingIds: [], summary: "Unrelated update." }; insert.run(id, repoKey, event.timestamp, JSON.stringify(event), event.timestamp); insertLink.run(repoKey, id, "unrelated-change"); }`,
          `db.close();`,
          `const recent = listGlobalCanonEvents(rootDir, { mode: "recent", limit: 1, changeId: "target-change" });`,
          `const complete = listGlobalCanonEvents(rootDir, { mode: "change-history", changeIds: ["target-change", "unrelated-change"] });`,
          `process.stdout.write(JSON.stringify({ recent, complete }));`,
        ].join("\n"),
      ],
      { cwd: rootDir, encoding: "utf8", env: testEnv(worktreeDb), timeout: 60_000 },
    );
    assert.equal(child.status, 0, child.stderr || child.stdout);
    const payload = JSON.parse(child.stdout) as { recent: Array<{ id: string }>; complete: Array<{ id: string }> };
    assert.deepEqual(payload.recent.map((event) => event.id), ["target"]);
    assert.equal(payload.complete.length, 601);
    assert(payload.complete.some((event) => event.id === "target"));
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
  }
});

test("worktree create claims a task and prevents duplicate agent pickup", { timeout: 60_000 }, () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), "opencanon-worktree-cli-"));
  const worktreePath = path.join(tmpdir(), `opencanon-worktree-cli-wt-${Date.now()}`);
  const worktreeDb = path.join(rootDir, ".opencanon", "worktrees-test.sqlite");
  try {
    createAuthoringProject(rootDir);
    mkdirSync(path.join(rootDir, "src"), { recursive: true });
    mkdirSync(path.join(rootDir, "opencanon/changes"), { recursive: true });
    mkdirSync(path.join(rootDir, "docs/opencanon"), { recursive: true });
    writeFileSync(path.join(rootDir, "src/company.ts"), "export const company = true;\n");
    writeFileSync(
      path.join(rootDir, "opencanon/changes/index.ts"),
      [
        "import { defineChange } from \"@opencanon/core\";",
        "",
        "export default defineChange({",
        "  id: \"parallel-change\",",
        "  title: \"Parallel Change\",",
        "  kind: \"feature\",",
        "  intent: { problem: \"Agents collide\", outcome: \"Agents work in isolated worktrees\" },",
        "  checks: [{ id: \"smoke\", kind: \"command\", command: " + JSON.stringify(`${process.execPath} -e "process.exit(0)"`) + " }],",
        "  tasks: [",
        "    { id: \"model\", title: \"Model task\", files: [\"src/company.ts\"], checks: [\"smoke\"] },",
        "  ],",
        "  render: { kind: \"none\" },",
        "});",
        "",
      ].join("\n"),
    );
    git(rootDir, ["init"]);
    git(rootDir, ["config", "user.email", "opencanon@example.com"]);
    git(rootDir, ["config", "user.name", "OpenCanon Test"]);
    git(rootDir, ["add", "."]);
    git(rootDir, ["commit", "-m", "initial"]);

    const env = testEnv(worktreeDb);
    const created = spawnSync(
      process.execPath,
      [script, "worktree", "create", "parallel-change", "--task", "model", "--agent", "agent-a", "--path", worktreePath, "--format", "json"],
      { cwd: rootDir, encoding: "utf8", env, timeout: 60_000 },
    );
    assert.equal(created.status, 0, created.stderr || created.stdout);
    const createdPayload = JSON.parse(created.stdout) as {
      worktree: { path: string; id: string };
      lease: { status: string; agentId: string; taskId: string };
      commands: string[];
    };
    assert.equal(existsSync(createdPayload.worktree.path), true);
    assert.equal(createdPayload.lease.status, "active");
    assert.equal(createdPayload.lease.agentId, "agent-a");
    assert.equal(createdPayload.lease.taskId, "model");
    assert(createdPayload.commands.some((command) => command.includes("changes start parallel-change --task model --agent agent-a")));

    const started = spawnSync(process.execPath, [script, "changes", "start", "parallel-change", "--task", "model", "--agent", "agent-a"], {
      cwd: worktreePath,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    assert.equal(started.status, 0, started.stderr || started.stdout);

    const events = spawnSync(process.execPath, [script, "changes", "events", "parallel-change", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    assert.equal(events.status, 0, events.stderr || events.stdout);
    const eventPayload = JSON.parse(events.stdout) as { events: Array<{ type: string; actor?: string; taskIds: string[] }> };
    assert.deepEqual(eventPayload.events.map((event) => event.type), ["task-started", "task-claimed"]);
    assert(eventPayload.events.every((event) => event.actor === "agent-a"));

    const ready = spawnSync(process.execPath, [script, "changes", "ready", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    assert.equal(ready.status, 0, ready.stderr || ready.stdout);
    const readyPayload = JSON.parse(ready.stdout) as { ready: Array<{ taskId?: string }> };
    assert.deepEqual(readyPayload.ready.map((item) => item.taskId), []);

    const duplicate = spawnSync(process.execPath, [script, "changes", "claim", "parallel-change", "--task", "model", "--agent", "agent-b"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    assert.notEqual(duplicate.status, 0);
    assert.match(duplicate.stderr + duplicate.stdout, /already claimed by agent-a/);

    const listed = spawnSync(process.execPath, [script, "worktree", "list", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    assert.equal(listed.status, 0, listed.stderr || listed.stdout);
    const listedPayload = JSON.parse(listed.stdout) as { worktrees: Array<{ id: string; status: string }>; leases: Array<{ status: string; taskId: string }> };
    assert.deepEqual(listedPayload.worktrees.map((item) => item.status), ["active"]);
    assert.deepEqual(listedPayload.leases.filter((lease) => lease.status === "active").map((lease) => lease.taskId), ["model"]);

    const removed = spawnSync(process.execPath, [script, "worktree", "remove", createdPayload.worktree.id, "--force", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    assert.equal(removed.status, 0, removed.stderr || removed.stdout);
    assert.equal(existsSync(worktreePath), false);

    const listedAfterRemove = spawnSync(process.execPath, [script, "worktree", "list", "--format", "json"], {
      cwd: rootDir,
      encoding: "utf8",
      env,
      timeout: 60_000,
    });
    assert.equal(listedAfterRemove.status, 0, listedAfterRemove.stderr || listedAfterRemove.stdout);
    const listedAfterRemovePayload = JSON.parse(listedAfterRemove.stdout) as { worktrees: unknown[]; leases: unknown[] };
    assert.deepEqual(listedAfterRemovePayload.worktrees, []);
    assert.deepEqual(listedAfterRemovePayload.leases, []);
  } finally {
    rmSync(rootDir, { recursive: true, force: true });
    rmSync(worktreePath, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function testEnv(worktreeDb: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === "string") env[key] = value;
  }
  env.OPENCANON_SERVICE_REGISTRY_PATH = path.join(path.dirname(worktreeDb), "service.json");
  env.OPENCANON_WORKTREE_DB = worktreeDb;
  return env;
}
