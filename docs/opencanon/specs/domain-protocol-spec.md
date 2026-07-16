# Domain Protocol Spec

## Summary

CLI, MCP, browser, and desktop clients consume bounded revisioned projections and replayable events through one transport-independent runtime contract.

## Scope

- Files: `packages/core/src/protocol*.ts`
- Files: `packages/core/generated/domain-protocol.openapi.json`
- Files: `scripts/generate-domain-protocol.ts`
- Files: `packages/core/src/contracts-runtime.ts`
- Files: `packages/engine/src/index.ts`
- Files: `crates/opencanon-engine/src/{contracts,project,state}.rs`
- Files: `crates/opencanon-engine/src/project/{code_graph_connection,product_model_store,protocol_event_store}.rs`
- Files: `crates/opencanon-engine/src/migrations/014_project_publication.sql`
- Files: `packages/runtime/src/{project-refresh-publication,state-manager,state}.ts`
- Files: `packages/runtime/src/routes.ts`
- Files: `packages/runtime/src/server-routes.ts`
- Files: `packages/runtime/src/server-events.ts`
- Files: `packages/runtime/src/local-protocol.ts`
- Files: `packages/runtime/src/server-http.ts`
- Files: `packages/runtime/src/protocol-policy.ts`
- Files: `packages/cli/src/{brief,changes,context,feedback,gate,graph,mcp,opencode-plugin,refactor,review,runtime-client,search,symbols,validate}.ts`
- Files: `packages/runtime/test/*.test.ts`
- Files: `tests/{contracts,cli-reporting,runtime-events,mcp}.test.ts`
- Docs: `docs/opencanon/specs/domain-protocol-spec.md`

## Impact surfaces

- [Local service control plane](../areas/local-service-and-runtimes.md#local-service-and-project-runtimes)
- [Project Canon model](../areas/project-map-governance.md#project-map-governance)
- [Project Knowledge](../areas/project-knowledge-index.md#project-knowledge)
- [Release and update path](../areas/runtime-release-update.md#runtime-updates)

## Areas

- [Local Service and Project Runtimes](../areas/local-service-and-runtimes.md)
- [Project Map Governance](../areas/project-map-governance.md)
- [Project Knowledge](../areas/project-knowledge-index.md)
- [Runtime Updates](../areas/runtime-release-update.md)

## Checks

- `protocol-tests` test `packages/runtime/test/protocol.test.ts`
- `protocol-contract-drift` command `npm run protocol:check`
- `contracts-tests` test `tests/contracts.test.ts`
- `runtime-event-tests` test `tests/runtime-events.test.ts`
- `runtime-client-tests` test `packages/runtime/test/client.test.ts`
- `cli-tests` test `tests/cli-reporting.test.ts`
- `mcp-tests` test `tests/mcp.test.ts`
- `engine-publication-tests` command `npm run check:engine`
- `coordinator-tests` test `packages/runtime/test/state-manager.test.ts`
- `project-doctor` doctor

## Rules

Rule `one-operation-registry`: One typed operation registry owns request, response, authorization, consistency, cost, idempotency, cancellation, and transport mappings.
- runtime routing and clients use the same operation ids
- every operation has complete policy
- the generated API description is deterministic
Checks: `protocol-tests`, `protocol-contract-drift`, `contracts-tests`

Rule `projections-are-bounded-and-revisioned`: Every project read returns a bounded projection tied to the exact published revision used to compute it.
- collections have fixed limits and opaque cursors
- graph reads return bounded neighborhoods
- no routine response contains the complete project snapshot
Checks: `protocol-tests`, `runtime-client-tests`, `cli-tests`

Rule `events-are-replayable-invalidations`: Live project events carry monotonic cursors, published revisions, affected domains, and bounded progress without embedding project projections.
- reconnect replays unseen events once in order
- expired history requests explicit resynchronization
- slow clients are bounded by queued bytes
Checks: `runtime-event-tests`, `runtime-client-tests`

Rule `publication-is-atomic-and-monotonic`: Project State commits each monotonic published revision, accepted product projection, active graph generation, Canon history, and replay event as one durable publication boundary.
- failed publication keeps the previous graph and revision
- runtime restart resumes above the last published revision
- coalesced refreshes may skip revisions but can never publish a revision at or below the current one
- the serving Project State is the sole graph publication owner while isolated analysis can only stage generations into that owner
- generation cleanup cannot remove a staged graph during publication
- live delivery relays the committed replay event without appending it again
- unchanged refreshes advance revision without rewriting the product projection
Checks: `engine-publication-tests`, `coordinator-tests`, `runtime-event-tests`, `runtime-client-tests`

Rule `transports-preserve-domain-semantics`: HTTP and local pipe are adapters over the same domain operations and return identical success, problem, revision, and cancellation semantics.
- authorization precedes admission
- unsafe commands are never replayed automatically
- capacity is held through response delivery
Checks: `protocol-tests`, `runtime-client-tests`

Rule `complete-snapshots-stay-internal`: Complete runtime snapshots remain an internal accepted-state representation and never cross a public transport or event stream.
- the snapshot API is absent
- CLI and MCP use bounded operations
- diagnostic export, if introduced, is an isolated artifact operation
Checks: `contracts-tests`, `cli-tests`, `mcp-tests`

## Scenarios

Scenario `gui-resumes-after-disconnect`
- Given a GUI has cached Canon and Activity at a published revision
- Given its event connection closes
- When the GUI reconnects with its last event cursor
- Then unseen invalidations replay in order
- Then only affected projections refetch
- Then expired history requests explicit resynchronization
Checks: `runtime-event-tests`, `runtime-client-tests`

Scenario `agent-validates-large-project`
- Given a project contains thousands of files and definitions
- When an agent runs changed or project validation
- Then validation executes as a bounded runtime operation
- Then the client does not download a project snapshot
- Then the result names its published revision
Checks: `runtime-client-tests`, `cli-tests`

## Governance

- infer governing conventions from spec scope
- convention [Runtime failures use explicit error payloads](../canon/explicit-error-contracts.md)
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
