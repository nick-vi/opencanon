import { z } from "zod";

export const WorktreeVcsKind = {
  Git: "git",
  Local: "local",
} as const;
export type WorktreeVcsKind = (typeof WorktreeVcsKind)[keyof typeof WorktreeVcsKind];

export const WorktreeRecordStatus = {
  Active: "active",
  Removed: "removed",
  Stale: "stale",
} as const;
export type WorktreeRecordStatus = (typeof WorktreeRecordStatus)[keyof typeof WorktreeRecordStatus];

export const TaskLeaseStatus = {
  Active: "active",
  Released: "released",
  Stale: "stale",
} as const;
export type TaskLeaseStatus = (typeof TaskLeaseStatus)[keyof typeof TaskLeaseStatus];

export const RepositoryIdentitySchema = z.object({
  repoKey: z.string().min(1),
  vcs: z.enum([WorktreeVcsKind.Git, WorktreeVcsKind.Local]),
  rootDir: z.string().min(1),
  gitRoot: z.string().min(1).optional(),
  gitCommonDir: z.string().min(1).optional(),
  headSha: z.string().min(1).optional(),
});
export type RepositoryIdentity = z.infer<typeof RepositoryIdentitySchema>;

export const WorktreeRecordSchema = z.object({
  id: z.string().min(1),
  repoKey: z.string().min(1),
  path: z.string().min(1),
  branch: z.string().min(1).optional(),
  baseRef: z.string().min(1),
  baseSha: z.string().min(1).optional(),
  changeId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  status: z.enum([WorktreeRecordStatus.Active, WorktreeRecordStatus.Removed, WorktreeRecordStatus.Stale]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  lastSeenAt: z.string().datetime(),
});
export type WorktreeRecord = z.infer<typeof WorktreeRecordSchema>;

export const TaskLeaseSchema = z.object({
  id: z.string().min(1),
  repoKey: z.string().min(1),
  changeId: z.string().min(1),
  taskId: z.string().min(1),
  agentId: z.string().min(1),
  worktreeId: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1).optional(),
  baseSha: z.string().min(1).optional(),
  status: z.enum([TaskLeaseStatus.Active, TaskLeaseStatus.Released, TaskLeaseStatus.Stale]),
  claimedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  expiresAt: z.string().datetime(),
  releasedAt: z.string().datetime().optional(),
  summary: z.string().min(1),
});
export type TaskLease = z.infer<typeof TaskLeaseSchema>;

export const TaskLeaseSummarySchema = TaskLeaseSchema.pick({
  id: true,
  repoKey: true,
  changeId: true,
  taskId: true,
  agentId: true,
  worktreeId: true,
  worktreePath: true,
  branch: true,
  baseSha: true,
  status: true,
  claimedAt: true,
  updatedAt: true,
  expiresAt: true,
});
export type TaskLeaseSummary = z.infer<typeof TaskLeaseSummarySchema>;

export const TaskLeaseClaimAction = {
  Claimed: "claimed",
  Renewed: "renewed",
} as const;
export type TaskLeaseClaimAction = (typeof TaskLeaseClaimAction)[keyof typeof TaskLeaseClaimAction];

export const TaskLeaseClaimResultSchema = z.object({
  action: z.enum([TaskLeaseClaimAction.Claimed, TaskLeaseClaimAction.Renewed]),
  lease: TaskLeaseSchema,
});
export type TaskLeaseClaimResult = z.infer<typeof TaskLeaseClaimResultSchema>;

export const WorktreeOverviewSchema = z.object({
  repository: RepositoryIdentitySchema,
  worktrees: z.array(WorktreeRecordSchema),
  leases: z.array(TaskLeaseSchema),
});
export type WorktreeOverview = z.infer<typeof WorktreeOverviewSchema>;
