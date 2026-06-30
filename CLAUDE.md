# Agent Instructions

<opencanon>
This project uses OpenCanon for Project Canon, active Changes, scoped context, Proof, and validation.

Start with:
- `opencanon brief --format json`

Before editing known files:
- `opencanon context --files <paths...>`

Before finishing:
- `opencanon validate --changed`
- `opencanon doctor`

OpenCanon defines what is true, what is in scope, and how work is proven. Agents should use that context to complete coherent, verified work with minimal routine handoff.

Treat human attention as scarce. Spend agent effort on investigation, edge cases, validation, and clear handoff, while keeping changes simple and bounded by OpenCanon Changes, scoped context, impact surfaces, and Proof requirements.

Prefer finished, proven slices of work over partial edits. Do not expand scope unless it directly improves correctness, maintainability, or verification for the selected task.

Use OpenCanon CLI or MCP for live project state. Use the OpenCanon skill for the detailed workflow when your agent supports skills.
Do not copy detailed conventions, specs, or architecture here; load scoped OpenCanon context instead.
Put temporary markdown artifacts under `{REPO_ROOT}/tmp/`, not the project root.
</opencanon>
