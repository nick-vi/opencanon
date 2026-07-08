# Runtime Updates

## Summary

Runtime updates are selected from signed manifests with target-specific SHA-256 bundles.

## Ownership

Files: package.json, package-lock.json, packages/*/package.json, packages/distribution/src/update.ts, packages/distribution/src/node.ts, packages/distribution/package.json, packages/cli/src/update.ts, packages/cli/package.json, packages/core/src/release-manifest.ts, packages/core/src/release-keys.ts, scripts/**, packages/distribution/test/update.test.ts, tests/update-guard.test.ts
Commands: opencanon update (cli)

## Impact surfaces

- [Release and update path](runtime-release-update.md#runtime-updates)

## Checks

- `release-update-tests` test `tests/release-update-e2e.test.ts`
- `release-check` command `npm run release:check`

## Stories

Story `targeted-runtime-install`: as developer, I want updates to select the current platform bundle automatically, so runtime and engine versions stay in lockstep.
- manifest checks validate hashes
- install rehearsal verifies runtime layout
- the CLI supplies service and project runtime safety guards before writes
- installed updates report the Doctor fix command for managed project artifacts
Checks: `release-update-tests`, `release-check`

## Behaviors

Behavior `refuses-unsafe-update`: updater applies a runtime bundle; hash or signature failures stop before replacing installed files.
Checks: `release-update-tests`

Behavior `reports-project-refresh-action`: updater installs a new runtime bundle; the apply result reports opencanon doctor --fix as the only managed-project-artifact repair path.
Checks: `release-update-tests`

## Governance

- infer governing conventions from owned scope
- convention [Secrets and environment config stay out of source literals](../canon/hardcoded-secrets-and-config.md)
