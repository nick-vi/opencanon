# Implementation Workflow

Implementation starts by loading the smallest context that can make the work correct.

1. Run `brief --format json` for ready work, or `context --files <paths...>` when the touched files are known.
2. If the work maps to a Change and can run in isolation, run `worktree create <change-id> --task <task-id>` from the project root, move into the printed worktree, then start the task.
3. If the work must stay in the current checkout, run `changes show <change-id> --format json`, then `changes claim <change-id> --task <task-id>` and `changes start <change-id> --task <task-id>` before editing.
4. Edit source definitions first when behavior, rules, docs, or agent instructions change; render generated docs after source changes.
5. Keep generated state derived. If a generated doc is wrong, fix the definition or renderer.
6. Run the narrowest relevant Proof, then broaden based on risk.
7. Record blockers with `changes block` instead of leaving task state ambiguous.
8. Move work to review or close only after declared checks pass.
