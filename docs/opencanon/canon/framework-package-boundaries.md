# Framework packages depend inward

Convention id: `framework-package-boundaries`.

## Rule

OpenCanon framework packages must depend only on approved lower-level packages.

## Applies to

- from `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

- Kind: `validator`
- Severity: `error`
- Scope: `import-edge`
- Facts: `imports`

## Related conventions

- [framework-package-boundaries](opencanon://conventions/framework-package-boundaries)
