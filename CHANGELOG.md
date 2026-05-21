# Changelog

## v0.3.10 - 2026-05-21

- Fixed the UI smoke indexing check to use explicit daemon reindexing instead of CI-sensitive file watcher timing.

## v0.3.9 - 2026-05-21

- Fixed the UI smoke watcher check to mutate a tracked project file instead of relying on untracked file discovery.

## v0.3.8 - 2026-05-21

- Fixed daemon validator graph reloads for imported validator modules.
- Added explicit cross-scope project file access for validators.
- Added wrapper-aware Tauri command parity and a Tauri desktop example bundle.
- Improved doctor output for decision backrefs and fixture coverage.

## v0.3.7 - 2026-05-21

- Fixed default project scope so skill implementation files are ignored while validator fixtures remain checkable.

## v0.3.6 - 2026-05-21

- Fixed DRY bundle fixture coverage so installed bundles pass fixture validation.

## v0.3.5 - 2026-05-21

- Fixed example bundle source globs so generated validators install with valid glob patterns.

## v0.3.4 - 2026-05-21

- Fixed example bundles so installed validators reference their bundled decisions.

## v0.3.3 - 2026-05-21

- Fixed bundle validator index wiring for modules that export arrays of validators.

## v0.3.2 - 2026-05-21

- Fixed setup manifest propagation when `OPENCANON_UPDATE_MANIFEST` is used.
- Updated generated skill barrels to export the full curated validator factory surface.

## v0.3.1 - 2026-05-21

- Fixed bundle installs so generated validator modules are wired into the validators index and run immediately.
- Made example bundles portable outside the source checkout.
- Added JSON output support for `symbols` and `graph` commands to match documented CLI usage.

## v0.3.0 - 2026-05-21

- Added bundle-driven migration and graph-backed DRY examples with before/after project fixtures.
- Added validator and bundle API improvements for migration references, similar function checks, unused exports, and hardcoded value policies.
- Added skill-local runtime ignore handling and replaced the old agent brief init flow with `init --non-interactive`.
- Improved documentation site examples, mobile docs navigation, tree rendering, and diff displays.

## v0.2.2 - 2026-05-20

- Ignored generated runtime and daemon state during setup/init so consumer repos commit only source scaffold files.

## v0.2.1 - 2026-05-20

- Fixed release metadata so the engine binary reports the release version.

## v0.2.0 - 2026-05-20

- Added scoped graph search and symbol-kind filtering for repository queries.
- Added graph-backed migration and unused-export validation improvements.
- Added refactor planning APIs and refreshed release/runtime documentation.

## v0.1.0 - 2026-05-19

- Initial OpenCanon release.
