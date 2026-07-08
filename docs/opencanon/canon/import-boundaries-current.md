# Imports preserve local ownership boundaries

Convention id: `import-boundaries-current`.
Render style: `reference`.

## Rule

Rule: Deep relative imports are treated as a boundary smell because they make layer ownership implicit.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx}`
- file glob `tests/**/*.{ts,tsx}`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Agents tend to copy nearby imports. Deep relative paths make it hard to see whether a dependency direction is intentional.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [no-deep-relative-imports](opencanon://conventions/no-deep-relative-imports)
- [source-files-stay-cohesive](opencanon://conventions/source-files-stay-cohesive)
