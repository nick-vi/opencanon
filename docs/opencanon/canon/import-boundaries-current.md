# Imports preserve local ownership boundaries

## Rule

Deep relative imports are treated as a boundary smell because they make layer ownership implicit.

## Applies to

- `src/**/*.{ts,tsx}`
- `tests/**/*.{ts,tsx}`
- `packages/*/src/**/*.{ts,tsx}`

## Why

Agents tend to copy nearby imports. Deep relative paths make it hard to see whether a dependency direction is intentional.

## Related conventions

- [Imports avoid deep relative parent climbs](no-deep-relative-imports.md)
- [Source files keep one primary responsibility](source-files-stay-cohesive.md)
