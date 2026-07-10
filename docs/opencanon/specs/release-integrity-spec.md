# Release Integrity Spec

## Summary

Release publication is gated by the same proof path used for local readiness, including runtime build, validation, doctor, install rehearsal, and native embedding smoke coverage.

## Scope

- Files: `.github/workflows/release.yml`
- Files: `.github/workflows/ci.yml`
- Files: `package.json`
- Files: `scripts/native-embedding-smoke.ts`
- Files: `scripts/publish-opencanon-release.ts`
- Files: `scripts/check-release-consistency.ts`
- Files: `scripts/create-opencanon-release.ts`
- Files: `scripts/rehearse-opencanon-install.ts`
- Files: `tests/release.test.ts`
- Docs: `docs/opencanon/specs/release-integrity-spec.md`

## Impact surfaces

- [Release and update path](../areas/runtime-release-update.md#runtime-updates)
- [Project Knowledge](../areas/project-knowledge-index.md#project-knowledge)

## Areas

- [Runtime Updates](../areas/runtime-release-update.md)
- [Project Knowledge](../areas/project-knowledge-index.md)

## Checks

- `release-tests` test `tests/release.test.ts`
- `release-check` command `npm run release:check`
- `native-embedding-smoke` command `npm run smoke:native-embedding`

## Rules

Rule `release-workflow-runs-proof`: A tag or manual release workflow must run the full release gate before it can publish runtime assets.
- release.yml has a preflight job
- publish-release depends on preflight
- engine builds depend on preflight
Checks: `release-tests`, `release-check`

Rule `release-helper-runs-same-proof`: The local release helper must run the same check:ci proof before creating and pushing a release tag.
- release publish runs check:ci before commit and tag
- release publish watches the tag workflow by commit
Checks: `release-tests`

Rule `native-embedding-smoke-is-explicit`: Native embedding smoke coverage must either run and fail on error or be invoked through an explicitly optional command.
- check:ci invokes the required native embedding smoke
- the smoke script does not silently skip
- optional smoke uses an explicit optional flag
Checks: `release-tests`, `native-embedding-smoke`

## Scenarios

Scenario `manual-release-cannot-bypass-proof`
- Given a maintainer starts the Release workflow manually for an existing tag
- When the release job runs
- Then the preflight job checks the tagged commit
- Then asset publication waits for preflight success
Checks: `release-tests`, `release-check`

Scenario `embedding-config-regression-is-caught`
- Given Project Knowledge uses a configured native embedding model
- When the release gate runs
- Then native embedding code loads the configured model path
- Then invalid vectors or loading failures fail the gate
Checks: `native-embedding-smoke`

## Governance

- infer governing conventions from spec scope
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
