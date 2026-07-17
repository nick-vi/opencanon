# Release Integrity Spec

## Summary

Release publication is an explicit, version-locked operation gated by the same proof path used for local readiness, dependency security, runtime build, validation, Doctor, install rehearsal, and service-owned GGUF inference smoke coverage.

## Scope

- Files: `.github/workflows/release.yml`
- Files: `.github/workflows/ci.yml`
- Files: `package.json`
- Files: `scripts/gguf-inference-smoke.ts`
- Files: `scripts/prepare-opencanon-release.ts`
- Files: `scripts/publish-opencanon-release.ts`
- Files: `scripts/check-release-consistency.ts`
- Files: `scripts/create-opencanon-release.ts`
- Files: `scripts/rehearse-opencanon-install.ts`
- Files: `crates/*/Cargo.toml`
- Files: `crates/*/Cargo.lock`
- Files: `tests/release.test.ts`
- Docs: `docs/runtime-update-security.md`
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
- `gguf-inference-smoke` command `npm run smoke:gguf-inference`

## Rules

Rule `release-workflow-runs-proof`: Only an explicit workflow dispatch for an existing tag may run the full release gate and publish runtime assets.
- pushing a tag does not start publication
- release.yml has a preflight job
- publish-release depends on preflight
- engine builds depend on preflight
Checks: `release-tests`, `release-check`

Rule `release-helper-runs-same-proof`: The local release helper must run the same check:ci proof before creating and pushing a release tag.
- release publish runs check:ci before commit and tag
- release publish dispatches the release workflow explicitly
- release publish watches the dispatched workflow by tagged commit
Checks: `release-tests`

Rule `release-versions-move-together`: Every release-owned TypeScript package, Rust crate, engine constant, and committed lockfile must advertise the same runtime version and be updated by one preparation command.
- release check covers every workspace package
- release check covers every OpenCanon crate and lock entry
- release prepare updates the complete version set
Checks: `release-tests`, `release-check`

Rule `release-supply-chain-is-audited`: The local and release gates audit shipped npm dependencies and every committed Cargo lockfile, reject vulnerable or unsound dependencies, and pin third-party workflow actions to immutable commits.
- npm shipped dependencies are audited
- all Cargo lockfiles are audited
- unsound advisories fail
- workflow actions use immutable SHAs
Checks: `release-tests`, `release-check`

Rule `gguf-inference-smoke-is-explicit`: Service-owned GGUF inference smoke coverage must either run and fail on error or be invoked through an explicitly optional command.
- check:ci invokes the required GGUF inference smoke
- the smoke script does not silently skip
- optional smoke uses an explicit optional flag
Checks: `release-tests`, `gguf-inference-smoke`

## Scenarios

Scenario `manual-release-cannot-bypass-proof`
- Given a maintainer starts the Release workflow manually for an existing tag
- When the release job runs
- Then the preflight job checks the tagged commit
- Then asset publication waits for preflight success
Checks: `release-tests`, `release-check`

Scenario `tag-push-is-inert`
- Given a release tag is created or pushed
- When no maintainer explicitly dispatches the Release workflow
- Then no release build starts
- Then no signing secret is requested
- Then no assets are published
Checks: `release-tests`, `release-check`

Scenario `embedding-config-regression-is-caught`
- Given Project Knowledge uses a configured GGUF embedding model
- When the release gate runs
- Then the isolated inference host loads the configured model
- Then invalid vectors, duplicate model residency, missing eviction, or loading failures fail the gate
Checks: `gguf-inference-smoke`

## Governance

- infer governing conventions from spec scope
- convention [Repo definitions own truth; generated state stays derived](../canon/state-ownership-current.md)
- convention [Tests scale with blast radius](../canon/tests-follow-risk.md)
