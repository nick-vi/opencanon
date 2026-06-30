# Runtime Updates

Area id: `runtime-release-update`.
Render style: `reference`.

## Summary

Summary: Runtime updates are selected from signed manifests with target-specific SHA-256 bundles.

## Ownership

Files: package.json, package-lock.json, packages/*/package.json, packages/distribution/src/update.ts, packages/distribution/src/node.ts, packages/distribution/package.json, packages/cli/src/update.ts, packages/cli/package.json, packages/core/src/release-manifest.ts, scripts/**, packages/distribution/test/update.test.ts, tests/update-guard.test.ts
Commands: opencanon update (cli)

## Impact surfaces

- [release-update](opencanon://impact-surfaces/release-update)

## Checks

- `release-update-tests` test `tests/release-update-e2e.test.ts`
- `release-check` command `npm run release:check`

## Stories

Story `targeted-runtime-install`: as developer, I want updates to select the current platform bundle automatically, so runtime and engine versions stay in lockstep.
- manifest checks validate hashes
- install rehearsal verifies runtime layout
- the CLI supplies service and project runtime safety guards before writes
Checks: `release-update-tests`, `release-check`

## Behaviors

Behavior `refuses-unsafe-update`: updater applies a runtime bundle; hash or signature failures stop before replacing installed files.
Checks: `release-update-tests`

## Dependencies

No area dependencies are recorded.

## Governance

- infer governing conventions from owned scope
- convention [hardcoded-secrets-and-config](opencanon://conventions/hardcoded-secrets-and-config)
