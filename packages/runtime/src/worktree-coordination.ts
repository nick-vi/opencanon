import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  CanonEventSchema,
  TaskLeaseClaimAction,
  TaskLeaseSchema,
  TaskLeaseStatus,
  WorktreeRecordSchema,
  WorktreeRecordStatus,
  WorktreeVcsKind,
  createOpenCanonDiagnostic,
  type CanonEvent,
  type RepositoryIdentity,
  type TaskLease,
  type TaskLeaseClaimResult,
  type TaskLeaseSummary,
  type WorktreeOverview,
  type WorktreeRecord,
} from "@opencanon/core";

const CoordinationSchemaVersion = 1;
const DefaultLeaseTtlMs = 12 * 60 * 60 * 1000;
const WorktreeDbEnv = "OPENCANON_WORKTREE_DB";

const SqlText = {
  CreateTables: `
    create table if not exists metadata (
      key text primary key,
      value text not null
    ) strict;

    create table if not exists repositories (
      repo_key text primary key,
      vcs text not null,
      root_dir text not null,
      git_root text,
      git_common_dir text,
      head_sha text,
      created_at text not null,
      updated_at text not null
    ) strict;

    create table if not exists worktrees (
      id text primary key,
      repo_key text not null,
      path text not null,
      branch text,
      base_ref text not null,
      base_sha text,
      change_id text not null,
      task_id text not null,
      agent_id text not null,
      status text not null,
      created_at text not null,
      updated_at text not null,
      last_seen_at text not null
    ) strict;

    create table if not exists task_leases (
      id text primary key,
      repo_key text not null,
      change_id text not null,
      task_id text not null,
      agent_id text not null,
      worktree_id text not null,
      worktree_path text not null,
      branch text,
      base_sha text,
      status text not null,
      claimed_at text not null,
      updated_at text not null,
      expires_at text not null,
      released_at text,
      summary text not null
    ) strict;

    create unique index if not exists task_leases_active_unique
      on task_leases(repo_key, change_id, task_id)
      where status = 'active';

    create table if not exists activity_events (
      id text primary key,
      repo_key text not null,
      timestamp text not null,
      event_json text not null,
      created_at text not null
    ) strict;
  `,
} as const;

export type WorktreeClaimInput = {
  rootDir: string;
  changeId: string;
  taskId: string;
  agentId?: string | undefined;
  worktreeId?: string | undefined;
  worktreePath?: string | undefined;
  branch?: string | undefined;
  baseSha?: string | undefined;
  summary?: string | undefined;
  ttlMs?: number | undefined;
};

export type WorktreeReleaseInput = {
  rootDir: string;
  changeId: string;
  taskId: string;
  agentId?: string | undefined;
  worktreePath?: string | undefined;
  status?: typeof TaskLeaseStatus.Released | typeof TaskLeaseStatus.Stale | undefined;
  summary?: string | undefined;
};

export type WorktreeConflict = {
  ok: false;
  status: number;
  diagnostics: ReturnType<typeof createOpenCanonDiagnostic>[];
  activeLease?: TaskLease | undefined;
};

export type WorktreeClaimResponse = { ok: true; result: TaskLeaseClaimResult; repository: RepositoryIdentity } | WorktreeConflict;
export type WorktreeReleaseResponse = { ok: true; released: boolean; lease?: TaskLease; repository: RepositoryIdentity } | WorktreeConflict;
export type WorktreeOwnerResponse = { ok: true; lease: TaskLease; repository: RepositoryIdentity } | WorktreeConflict;

export type CreateManagedWorktreeInput = {
  rootDir: string;
  changeId: string;
  taskId: string;
  agentId?: string | undefined;
  requestedPath?: string | undefined;
  baseRef?: string | undefined;
  branch?: string | undefined;
};

export type CreateManagedWorktreeResult = {
  repository: RepositoryIdentity;
  worktree: WorktreeRecord;
  lease: TaskLease;
  commands: string[];
};

export type RemoveManagedWorktreeResult = {
  repository: RepositoryIdentity;
  worktree: WorktreeRecord;
  removed: boolean;
  releasedLeaseIds: string[];
};

export type ReapWorktreesResult = {
  repository: RepositoryIdentity;
  staleLeases: TaskLease[];
  staleWorktrees: WorktreeRecord[];
};

export function worktreeCoordinationDbPath(homeDir = homedir()): string {
  const configured = process.env[WorktreeDbEnv]?.trim();
  if (configured) return configured;
  return path.join(homeDir, ".opencanon", "worktrees.sqlite");
}

export function worktreeCoordinationSignalPath(homeDir = homedir()): string {
  return `${worktreeCoordinationDbPath(homeDir)}.signal`;
}

export function ensureWorktreeCoordinationSignal(): string {
  const signalPath = worktreeCoordinationSignalPath();
  mkdirSync(path.dirname(signalPath), { recursive: true });
  if (!existsSync(signalPath)) writeFileSync(signalPath, "0\n");
  return signalPath;
}

export function resolveRepositoryIdentity(rootDir: string): RepositoryIdentity {
  const resolvedRoot = realpathOrInput(rootDir);
  const gitRoot = gitOutput(resolvedRoot, ["rev-parse", "--show-toplevel"]);
  if (gitRoot.ok) {
    const gitCommonDir = gitOutput(resolvedRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    const headSha = gitOutput(resolvedRoot, ["rev-parse", "HEAD"]);
    const commonDir = realpathOrInput(gitCommonDir.ok ? gitCommonDir.stdout : path.join(gitRoot.stdout, ".git"));
    return {
      repoKey: stableHash(["opencanon-git-repo", commonDir]),
      vcs: WorktreeVcsKind.Git,
      rootDir: resolvedRoot,
      gitRoot: realpathOrInput(gitRoot.stdout),
      gitCommonDir: commonDir,
      ...(headSha.ok ? { headSha: headSha.stdout } : {}),
    };
  }
  return {
    repoKey: stableHash(["opencanon-local-root", resolvedRoot]),
    vcs: WorktreeVcsKind.Local,
    rootDir: resolvedRoot,
  };
}

export function listWorktreeOverview(rootDir: string): WorktreeOverview {
  const repository = resolveRepositoryIdentity(rootDir);
  const db = openCoordinationDb();
  try {
    upsertRepository(db, repository);
    markMissingWorktreesStale(db, repository);
    return {
      repository,
      worktrees: listWorktreeRecords(db, repository.repoKey),
      leases: listTaskLeasesForRepo(db, repository.repoKey),
    };
  } finally {
    db.close();
  }
}

export function worktreeOverviewSignature(rootDir: string): string {
  const overview = listWorktreeOverview(rootDir);
  return JSON.stringify({
    repoKey: overview.repository.repoKey,
    worktrees: overview.worktrees.map((record) => [
      record.id,
      record.path,
      record.changeId,
      record.taskId,
      record.agentId,
      record.status,
      record.updatedAt,
      record.lastSeenAt,
    ]),
    leases: overview.leases.map((lease) => [
      lease.id,
      lease.changeId,
      lease.taskId,
      lease.agentId,
      lease.worktreeId,
      lease.worktreePath,
      lease.status,
      lease.updatedAt,
      lease.expiresAt,
      lease.releasedAt ?? "",
    ]),
  });
}

export function activeTaskLeaseSummaries(rootDir: string): TaskLeaseSummary[] {
  const repository = resolveRepositoryIdentity(rootDir);
  const db = openCoordinationDb();
  try {
    markExpiredLeasesStale(db, repository, nowIso());
    return listTaskLeasesForRepo(db, repository.repoKey)
      .filter((lease) => lease.status === TaskLeaseStatus.Active)
      .map(({ summary, releasedAt, ...lease }) => lease);
  } finally {
    db.close();
  }
}

export function writeGlobalCanonEvent(rootDir: string, event: CanonEvent): void {
  if ((event.changeIds ?? []).length === 0) return;
  const repository = resolveRepositoryIdentity(rootDir);
  const db = openCoordinationDb();
  let shouldSignal = false;
  try {
    upsertRepository(db, repository);
    db.prepare(
      `insert or ignore into activity_events(id, repo_key, timestamp, event_json, created_at)
       values (?, ?, ?, ?, ?)`,
    ).run(event.id, repository.repoKey, event.timestamp, JSON.stringify(event), nowIso());
    shouldSignal = true;
  } finally {
    db.close();
    if (shouldSignal) touchWorktreeCoordinationSignal();
  }
}

export function listGlobalCanonEvents(rootDir: string, limit = 50): CanonEvent[] {
  const repository = resolveRepositoryIdentity(rootDir);
  const db = openCoordinationDb();
  try {
    upsertRepository(db, repository);
    return db
      .prepare("select event_json from activity_events where repo_key = ? order by timestamp desc, id desc limit ?")
      .all(repository.repoKey, limit)
      .map((row) => CanonEventSchema.parse(JSON.parse(String((row as { event_json: unknown }).event_json))));
  } finally {
    db.close();
  }
}

export function mergeCanonEvents(events: readonly CanonEvent[], limit: number): CanonEvent[] {
  const byId = new Map<string, CanonEvent>();
  for (const event of events) byId.set(event.id, event);
  return [...byId.values()]
    .sort((left, right) => right.timestamp.localeCompare(left.timestamp) || right.id.localeCompare(left.id))
    .slice(0, limit);
}

export function claimTaskLease(input: WorktreeClaimInput): WorktreeClaimResponse {
  const repository = resolveRepositoryIdentity(input.rootDir);
  const db = openCoordinationDb();
  let shouldSignal = false;
  const now = nowIso();
  const expiresAt = new Date(Date.now() + (input.ttlMs ?? DefaultLeaseTtlMs)).toISOString();
  const agentId = normalizeAgentId(input.agentId);
  const worktreePath = realpathOrInput(input.worktreePath ?? input.rootDir);
  const worktreeId = input.worktreeId?.trim() || stableHash(["opencanon-worktree-path", repository.repoKey, worktreePath]);
  const summary = input.summary?.trim() || `Claimed ${input.changeId}/${input.taskId}.`;
  try {
    upsertRepository(db, repository);
    markExpiredLeasesStale(db, repository, now);
    db.exec("begin immediate");
    const active = findActiveLease(db, repository.repoKey, input.changeId, input.taskId);
    if (active) {
      if (sameLeaseOwner(active, { agentId, worktreeId, worktreePath })) {
        db.prepare(
          `update task_leases
           set updated_at = ?, expires_at = ?, summary = ?
           where id = ?`,
        ).run(now, expiresAt, summary, active.id);
        db.exec("commit");
        shouldSignal = true;
        return {
          ok: true,
          repository,
          result: {
            action: TaskLeaseClaimAction.Renewed,
            lease: { ...active, updatedAt: now, expiresAt, summary },
          },
        };
      }
      db.exec("rollback");
      return conflict(active, `Task ${input.changeId}/${input.taskId} is already claimed by ${active.agentId}.`);
    }

    const lease = TaskLeaseSchema.parse({
      id: `lease-${randomUUID()}`,
      repoKey: repository.repoKey,
      changeId: input.changeId,
      taskId: input.taskId,
      agentId,
      worktreeId,
      worktreePath,
      branch: emptyToUndefined(input.branch),
      baseSha: emptyToUndefined(input.baseSha ?? repository.headSha),
      status: TaskLeaseStatus.Active,
      claimedAt: now,
      updatedAt: now,
      expiresAt,
      summary,
    });
    insertTaskLease(db, lease);
    db.exec("commit");
    shouldSignal = true;
    return { ok: true, repository, result: { action: TaskLeaseClaimAction.Claimed, lease } };
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  } finally {
    db.close();
    if (shouldSignal) touchWorktreeCoordinationSignal();
  }
}

export function releaseTaskLease(input: WorktreeReleaseInput): WorktreeReleaseResponse {
  const repository = resolveRepositoryIdentity(input.rootDir);
  const db = openCoordinationDb();
  let shouldSignal = false;
  const now = nowIso();
  const explicitAgent = hasExplicitAgent(input.agentId);
  const agentId = normalizeAgentId(input.agentId);
  const worktreePath = realpathOrInput(input.worktreePath ?? input.rootDir);
  const status = input.status ?? TaskLeaseStatus.Released;
  try {
    upsertRepository(db, repository);
    db.exec("begin immediate");
    const active = findActiveLease(db, repository.repoKey, input.changeId, input.taskId);
    if (!active) {
      db.exec("commit");
      return { ok: true, released: false, repository };
    }
    if (!leaseOwnerMatches(active, { agentId, worktreePath, explicitAgent })) {
      db.exec("rollback");
      return conflict(active, `Task ${input.changeId}/${input.taskId} is claimed by ${active.agentId}.`);
    }
    const released = TaskLeaseSchema.parse({
      ...active,
      status,
      updatedAt: now,
      releasedAt: now,
      summary: input.summary?.trim() || active.summary,
    });
    db.prepare(
      `update task_leases
       set status = ?, updated_at = ?, released_at = ?, summary = ?
       where id = ?`,
    ).run(status, now, now, released.summary, released.id);
    db.exec("commit");
    shouldSignal = true;
    return { ok: true, released: true, lease: released, repository };
  } catch (error) {
    rollbackQuietly(db);
    throw error;
  } finally {
    db.close();
    if (shouldSignal) touchWorktreeCoordinationSignal();
  }
}

export function requireTaskLeaseOwner(input: WorktreeReleaseInput): WorktreeOwnerResponse {
  const repository = resolveRepositoryIdentity(input.rootDir);
  const db = openCoordinationDb();
  const explicitAgent = hasExplicitAgent(input.agentId);
  const agentId = normalizeAgentId(input.agentId);
  const worktreePath = realpathOrInput(input.worktreePath ?? input.rootDir);
  try {
    upsertRepository(db, repository);
    const active = findActiveLease(db, repository.repoKey, input.changeId, input.taskId);
    if (!active) {
      return {
        ok: false,
        status: 409,
        diagnostics: [
          createOpenCanonDiagnostic({
            code: "invalid-runtime-response",
            message: `Task ${input.changeId}/${input.taskId} must be claimed before this lifecycle event.`,
            action: `Run opencanon changes claim ${input.changeId} --task ${input.taskId}.`,
          }),
        ],
      };
    }
    if (!leaseOwnerMatches(active, { agentId, worktreePath, explicitAgent })) {
      return conflict(active, `Task ${input.changeId}/${input.taskId} is claimed by ${active.agentId}.`);
    }
    return { ok: true, lease: active, repository };
  } finally {
    db.close();
  }
}

export function createManagedWorktree(input: CreateManagedWorktreeInput): CreateManagedWorktreeResult {
  const repository = resolveRepositoryIdentity(input.rootDir);
  if (repository.vcs !== WorktreeVcsKind.Git || !repository.gitRoot) {
    throw new Error("OpenCanon worktree creation requires a Git repository.");
  }
  const baseRef = input.baseRef?.trim() || "HEAD";
  const baseSha = gitRequired(input.rootDir, ["rev-parse", baseRef]);
  const agentId = normalizeAgentId(input.agentId);
  const worktreePath = path.resolve(input.requestedPath?.trim() || defaultManagedWorktreePath(repository, input.changeId, input.taskId));
  if (existsSync(worktreePath)) throw new Error(`Worktree path already exists: ${worktreePath}`);
  mkdirSync(path.dirname(worktreePath), { recursive: true });

  const args = input.branch?.trim()
    ? ["worktree", "add", "-b", input.branch.trim(), worktreePath, baseRef]
    : ["worktree", "add", "--detach", worktreePath, baseRef];
  runGitOrThrow(repository.gitRoot, args);

  const db = openCoordinationDb();
  const now = nowIso();
  const branch = input.branch?.trim();
  const worktree = WorktreeRecordSchema.parse({
    id: `worktree-${randomUUID()}`,
    repoKey: repository.repoKey,
    path: realpathOrInput(worktreePath),
    branch: emptyToUndefined(branch),
    baseRef,
    baseSha,
    changeId: input.changeId,
    taskId: input.taskId,
    agentId,
    status: WorktreeRecordStatus.Active,
    createdAt: now,
    updatedAt: now,
    lastSeenAt: now,
  });
  try {
    upsertRepository(db, repository);
    upsertWorktreeRecord(db, worktree);
  } finally {
    db.close();
    touchWorktreeCoordinationSignal();
  }

  const claimed = claimTaskLease({
    rootDir: worktree.path,
    changeId: input.changeId,
    taskId: input.taskId,
    agentId,
    worktreeId: worktree.id,
    worktreePath: worktree.path,
    branch,
    baseSha,
    summary: `Claimed ${input.changeId}/${input.taskId} in managed worktree.`,
  });
  if (!claimed.ok) {
    try {
      runGitOrThrow(repository.gitRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      rmSync(worktreePath, { recursive: true, force: true });
    }
    markWorktreeRecordRemoved(worktree.id);
    throw new Error(claimed.diagnostics.map((diagnostic) => diagnostic.message).join("\n"));
  }
  writeGlobalCanonEvent(input.rootDir, CanonEventSchema.parse({
    id: `event-${randomUUID()}`,
    type: "task-claimed",
    timestamp: nowIso(),
    actor: agentId,
    changeIds: [input.changeId],
    taskIds: [input.taskId],
    summary: `Task ${input.changeId}/${input.taskId} claimed in managed worktree.`,
  }));

  return {
    repository,
    worktree,
    lease: claimed.result.lease,
    commands: [
      `cd ${shellQuote(worktree.path)}`,
      `opencanon brief --format json`,
      `opencanon changes start ${shellQuote(input.changeId)} --task ${shellQuote(input.taskId)} --agent ${shellQuote(agentId)}`,
    ],
  };
}

function markWorktreeRecordRemoved(worktreeId: string): void {
  const db = openCoordinationDb();
  let shouldSignal = false;
  const now = nowIso();
  try {
    db.prepare("update worktrees set status = ?, updated_at = ?, last_seen_at = ? where id = ?").run(WorktreeRecordStatus.Removed, now, now, worktreeId);
    shouldSignal = true;
  } finally {
    db.close();
    if (shouldSignal) touchWorktreeCoordinationSignal();
  }
}

export function removeManagedWorktree(rootDir: string, idOrPath: string, options: { force?: boolean } = {}): RemoveManagedWorktreeResult {
  const repository = resolveRepositoryIdentity(rootDir);
  const db = openCoordinationDb();
  let shouldSignal = false;
  try {
    upsertRepository(db, repository);
    const record = findWorktreeByIdOrPath(db, repository.repoKey, idOrPath);
    if (!record) throw new Error(`Unknown OpenCanon worktree: ${idOrPath}`);
    if (existsSync(record.path) && repository.vcs === WorktreeVcsKind.Git && repository.gitRoot) {
      const dirty = gitOutput(record.path, ["status", "--porcelain"]);
      if (dirty.ok && dirty.stdout.trim() && !options.force) {
        throw new Error(`Worktree has uncommitted changes: ${record.path}. Use --force to remove it.`);
      }
      runGitOrThrow(repository.gitRoot, ["worktree", "remove", ...(options.force ? ["--force"] : []), record.path]);
    } else {
      rmSync(record.path, { recursive: true, force: true });
    }
    const now = nowIso();
    const removed = WorktreeRecordSchema.parse({ ...record, status: WorktreeRecordStatus.Removed, updatedAt: now, lastSeenAt: now });
    db.prepare("update worktrees set status = ?, updated_at = ?, last_seen_at = ? where id = ?").run(removed.status, now, now, removed.id);
    const releasedLeaseIds = releaseLeasesForWorktree(db, repository.repoKey, removed.id, now);
    shouldSignal = true;
    return { repository, worktree: removed, removed: true, releasedLeaseIds };
  } finally {
    db.close();
    if (shouldSignal) touchWorktreeCoordinationSignal();
  }
}

export function reapWorktrees(rootDir: string): ReapWorktreesResult {
  const repository = resolveRepositoryIdentity(rootDir);
  const db = openCoordinationDb();
  let shouldSignal = false;
  const now = nowIso();
  try {
    upsertRepository(db, repository);
    const staleLeases = markExpiredLeasesStale(db, repository, now);
    const staleWorktrees = markMissingWorktreesStale(db, repository);
    shouldSignal = staleLeases.length > 0 || staleWorktrees.length > 0;
    return { repository, staleLeases, staleWorktrees };
  } finally {
    db.close();
    if (shouldSignal) touchWorktreeCoordinationSignal();
  }
}

function openCoordinationDb(): DatabaseSync {
  const dbPath = worktreeCoordinationDbPath();
  mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath);
  db.exec("pragma busy_timeout = 5000");
  db.exec(SqlText.CreateTables);
  db.prepare("insert or replace into metadata(key, value) values ('schema_version', ?)").run(String(CoordinationSchemaVersion));
  return db;
}

function touchWorktreeCoordinationSignal(): void {
  const signalPath = worktreeCoordinationSignalPath();
  mkdirSync(path.dirname(signalPath), { recursive: true });
  writeFileSync(signalPath, `${Date.now()}:${randomUUID()}\n`);
}

function upsertRepository(db: DatabaseSync, repository: RepositoryIdentity): void {
  const now = nowIso();
  db.prepare(
    `insert into repositories(repo_key, vcs, root_dir, git_root, git_common_dir, head_sha, created_at, updated_at)
     values (?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(repo_key) do update set
       vcs = excluded.vcs,
       root_dir = excluded.root_dir,
       git_root = excluded.git_root,
       git_common_dir = excluded.git_common_dir,
       head_sha = excluded.head_sha,
       updated_at = excluded.updated_at`,
  ).run(repository.repoKey, repository.vcs, repository.rootDir, repository.gitRoot ?? null, repository.gitCommonDir ?? null, repository.headSha ?? null, now, now);
}

function insertTaskLease(db: DatabaseSync, lease: TaskLease): void {
  db.prepare(
    `insert into task_leases(
      id, repo_key, change_id, task_id, agent_id, worktree_id, worktree_path, branch, base_sha,
      status, claimed_at, updated_at, expires_at, released_at, summary
    ) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    lease.id,
    lease.repoKey,
    lease.changeId,
    lease.taskId,
    lease.agentId,
    lease.worktreeId,
    lease.worktreePath,
    lease.branch ?? null,
    lease.baseSha ?? null,
    lease.status,
    lease.claimedAt,
    lease.updatedAt,
    lease.expiresAt,
    lease.releasedAt ?? null,
    lease.summary,
  );
}

function upsertWorktreeRecord(db: DatabaseSync, record: WorktreeRecord): void {
  db.prepare(
    `insert into worktrees(id, repo_key, path, branch, base_ref, base_sha, change_id, task_id, agent_id, status, created_at, updated_at, last_seen_at)
     values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     on conflict(id) do update set
       path = excluded.path,
       branch = excluded.branch,
       base_ref = excluded.base_ref,
       base_sha = excluded.base_sha,
       status = excluded.status,
       updated_at = excluded.updated_at,
       last_seen_at = excluded.last_seen_at`,
  ).run(
    record.id,
    record.repoKey,
    record.path,
    record.branch ?? null,
    record.baseRef,
    record.baseSha ?? null,
    record.changeId,
    record.taskId,
    record.agentId,
    record.status,
    record.createdAt,
    record.updatedAt,
    record.lastSeenAt,
  );
}

function findActiveLease(db: DatabaseSync, repoKey: string, changeId: string, taskId: string): TaskLease | undefined {
  const row = db.prepare("select * from task_leases where repo_key = ? and change_id = ? and task_id = ? and status = ?").get(repoKey, changeId, taskId, TaskLeaseStatus.Active);
  return row ? taskLeaseFromRow(row) : undefined;
}

function listTaskLeasesForRepo(db: DatabaseSync, repoKey: string): TaskLease[] {
  return db
    .prepare("select * from task_leases where repo_key = ? order by updated_at desc, id")
    .all(repoKey)
    .map(taskLeaseFromRow);
}

function listWorktreeRecords(db: DatabaseSync, repoKey: string): WorktreeRecord[] {
  return db
    .prepare("select * from worktrees where repo_key = ? order by updated_at desc, id")
    .all(repoKey)
    .map(worktreeRecordFromRow);
}

function findWorktreeByIdOrPath(db: DatabaseSync, repoKey: string, idOrPath: string): WorktreeRecord | undefined {
  const normalized = path.resolve(idOrPath);
  const row = db.prepare("select * from worktrees where repo_key = ? and (id = ? or path = ?)").get(repoKey, idOrPath, normalized);
  return row ? worktreeRecordFromRow(row) : undefined;
}

function markExpiredLeasesStale(db: DatabaseSync, repository: RepositoryIdentity, now: string): TaskLease[] {
  const expired = db
    .prepare("select * from task_leases where repo_key = ? and status = ? and expires_at < ?")
    .all(repository.repoKey, TaskLeaseStatus.Active, now)
    .map(taskLeaseFromRow);
  for (const lease of expired) {
    db.prepare("update task_leases set status = ?, updated_at = ?, released_at = ? where id = ?").run(TaskLeaseStatus.Stale, now, now, lease.id);
  }
  return expired.map((lease) => ({ ...lease, status: TaskLeaseStatus.Stale, updatedAt: now, releasedAt: now }));
}

function markMissingWorktreesStale(db: DatabaseSync, repository: RepositoryIdentity): WorktreeRecord[] {
  const now = nowIso();
  const active = listWorktreeRecords(db, repository.repoKey).filter((record) => record.status === WorktreeRecordStatus.Active);
  const missing = active.filter((record) => !existsSync(record.path));
  for (const record of missing) {
    db.prepare("update worktrees set status = ?, updated_at = ?, last_seen_at = ? where id = ?").run(WorktreeRecordStatus.Stale, now, now, record.id);
    releaseLeasesForWorktree(db, repository.repoKey, record.id, now, TaskLeaseStatus.Stale);
  }
  return missing.map((record) => ({ ...record, status: WorktreeRecordStatus.Stale, updatedAt: now, lastSeenAt: now }));
}

function releaseLeasesForWorktree(
  db: DatabaseSync,
  repoKey: string,
  worktreeId: string,
  now: string,
  status: typeof TaskLeaseStatus.Released | typeof TaskLeaseStatus.Stale = TaskLeaseStatus.Released,
): string[] {
  const rows = db.prepare("select * from task_leases where repo_key = ? and worktree_id = ? and status = ?").all(repoKey, worktreeId, TaskLeaseStatus.Active).map(taskLeaseFromRow);
  for (const lease of rows) {
    db.prepare("update task_leases set status = ?, updated_at = ?, released_at = ? where id = ?").run(status, now, now, lease.id);
  }
  return rows.map((lease) => lease.id);
}

function taskLeaseFromRow(row: unknown): TaskLease {
  const record = row as Record<string, unknown>;
  return TaskLeaseSchema.parse({
    id: record.id,
    repoKey: record.repo_key,
    changeId: record.change_id,
    taskId: record.task_id,
    agentId: record.agent_id,
    worktreeId: record.worktree_id,
    worktreePath: record.worktree_path,
    branch: nullableString(record.branch),
    baseSha: nullableString(record.base_sha),
    status: record.status,
    claimedAt: record.claimed_at,
    updatedAt: record.updated_at,
    expiresAt: record.expires_at,
    releasedAt: nullableString(record.released_at),
    summary: record.summary,
  });
}

function worktreeRecordFromRow(row: unknown): WorktreeRecord {
  const record = row as Record<string, unknown>;
  return WorktreeRecordSchema.parse({
    id: record.id,
    repoKey: record.repo_key,
    path: record.path,
    branch: nullableString(record.branch),
    baseRef: record.base_ref,
    baseSha: nullableString(record.base_sha),
    changeId: record.change_id,
    taskId: record.task_id,
    agentId: record.agent_id,
    status: record.status,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    lastSeenAt: record.last_seen_at,
  });
}

function conflict(activeLease: TaskLease, message: string): WorktreeConflict {
  return {
    ok: false,
    status: 409,
    activeLease,
    diagnostics: [
      createOpenCanonDiagnostic({
        code: "invalid-runtime-response",
        message,
        details: [`Active lease: ${activeLease.id}`, `Worktree: ${activeLease.worktreePath}`, `Expires: ${activeLease.expiresAt}`],
        action: "Choose another task, wait for the lease to release, or run opencanon worktree reap if the owner is stale.",
      }),
    ],
  };
}

function sameLeaseOwner(lease: TaskLease, input: { agentId: string; worktreeId: string; worktreePath: string }): boolean {
  return lease.agentId === input.agentId && (lease.worktreeId === input.worktreeId || lease.worktreePath === input.worktreePath);
}

function leaseOwnerMatches(lease: TaskLease, input: { agentId: string; worktreePath: string; explicitAgent: boolean }): boolean {
  if (lease.worktreePath !== input.worktreePath) return false;
  return input.explicitAgent ? lease.agentId === input.agentId : true;
}

function hasExplicitAgent(value: string | undefined): boolean {
  return Boolean(value?.trim());
}

function normalizeAgentId(value: string | undefined): string {
  const trimmed = value?.trim();
  if (trimmed) return trimmed;
  return process.env.OPENCANON_AGENT_ID?.trim() || process.env.USER?.trim() || `pid-${process.pid}`;
}

function defaultManagedWorktreePath(repository: RepositoryIdentity, changeId: string, taskId: string): string {
  return path.join(homedir(), ".opencanon", "worktrees", repository.repoKey, `${slug(changeId)}-${slug(taskId)}-${randomUUID().slice(0, 8)}`);
}

function gitOutput(cwd: string, args: string[]): { ok: true; stdout: string } | { ok: false; message: string } {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) return { ok: false, message: result.stderr.trim() || result.error?.message || "Git command failed." };
  return { ok: true, stdout: result.stdout.trim() };
}

function gitRequired(cwd: string, args: string[]): string {
  const result = gitOutput(cwd, args);
  if (!result.ok) throw new Error(result.message);
  return result.stdout;
}

function runGitOrThrow(cwd: string, args: string[]): void {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr.trim() || result.error?.message || `git ${args.join(" ")} failed.`);
}

function stableHash(parts: string[]): string {
  return createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
}

function realpathOrInput(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    return path.resolve(value);
  }
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "worktree";
}

function shellQuote(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : `'${value.replace(/'/g, "'\\''")}'`;
}

function nullableString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function nowIso(): string {
  return new Date().toISOString();
}

function rollbackQuietly(db: DatabaseSync): void {
  try {
    db.exec("rollback");
  } catch {
    return;
  }
}
