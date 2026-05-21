# Changelog

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
