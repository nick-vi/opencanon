# Review Workflow

Review starts from risk, not from a summary.

1. Load changed-file context with `context --changed`.
2. Check generated artifacts with `doctor` if docs, Project Canon, entry files, or runtime state changed.
3. Run `validate --changed` for convention Proof.
4. Use `review` for a read-only report when a concise CI-style view is useful.
5. For each issue, cite the exact file, behavior, and missing Proof.

Prioritize correctness, source-truth drift, broken generated artifacts, stale task state, runtime-process leaks, data loss, security issues, and missing tests for risky behavior.
