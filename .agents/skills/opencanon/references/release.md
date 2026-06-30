# Release Readiness

Do not publish or push release assets unless the user explicitly asks.

Useful checks:

- `npm run build:engine` for native engine bindings.
- `npm run build:runtime -- --bundle-node` for the packaged runtime tree.
- `npm run release:check` for release metadata consistency.
- `npm run release:manifest -- --asset-dir packages/engine/binaries --out-dir tmp/opencanon-release-check --channel stable --require-runtime --clean` for local manifest generation.
- `npm run rehearse:install -- --manifest tmp/opencanon-release-check/opencanon-runtime-manifest.json --no-runtime` for install rehearsal.

Release readiness is broader than `doctor`: it includes packaged assets, signing metadata, update manifest integrity, and install rehearsal.
