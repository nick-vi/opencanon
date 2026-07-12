# Change And Task Planning

A Change is active implementation intent. Its task graph is committed definition data; task progress is runtime Activity.

Use a Change when work has multiple steps, dependencies, meaningful checks, expected files, blockers, or runtime visibility needs.

Good Change tasks include a stable id, clear title, expected files or Surfaces, dependencies, checks, and durable definition updates when completed work changes Project Canon.

Agent flow:

1. `changes ready --format json` to find unblocked work that has no active task lease.
2. `changes show <change-id> --format json` to inspect dependencies, files, checks, and recent Activity.
3. Prefer `worktree create <change-id> --task <task-id>` for parallel agent work; it creates the Git worktree and claims the task atomically.
4. Use `changes claim` and `changes start` only when intentionally working in the current checkout.
5. `changes check --all` to run declared checks.
6. If the initiating client exits, use `changes runs list`, `show`, or `watch --after <sequence>` to resume observation; use `changes runs cancel` only to stop owned work intentionally.
7. `changes review` or `changes close` only after Proof is available.
8. `worktree list --format json` shows managed worktrees and active task leases; `worktree remove <id|path>` releases leases for a finished worktree.

Do not mutate the Change definition to represent progress. Progress events live in runtime state so source intent stays reviewable.
