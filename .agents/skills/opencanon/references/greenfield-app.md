# Greenfield App Workflow

Use OpenCanon when a project needs durable intent, runtime Proof, and agent-friendly context from the beginning.

1. Run `opencanon setup --yes --format json` to scaffold the repo and get an agent setup packet.
2. Use the setup packet to propose the smallest useful Project Canon first: one Area for ownership, one Spec for durable behavior, and one Change for the implementation plan.
3. Add conventions only when they express a rule that should outlive the current task or be enforced by Proof.
4. Keep generated docs derived from definitions. If rendered docs are wrong, fix the definition or renderer.
5. Start implementation from `opencanon brief --format json` or a specific `changes show` packet so work is grounded in ready tasks and current context.
6. Run scoped Proof before broad Proof: `validate --files`, declared `changes check`, then `doctor` when generated artifacts or setup changed.
