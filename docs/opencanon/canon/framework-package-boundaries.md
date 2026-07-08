# Framework packages depend inward

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

- [Framework packages depend inward](framework-package-boundaries.md)
