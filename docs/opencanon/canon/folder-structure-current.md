# Folders use approved responsibility names

## Rule

Folders should communicate ownership and layer responsibility instead of becoming dumping grounds.

## Applies to

- `src/**`
- `tests/**`
- `packages/*/src/**`

## Why

Agents copy folder names they see. Ambiguous folders make ownership and import direction harder to infer.

## Related conventions

- [Folders name real responsibilities](no-dumpster-folders.md)
- [Service files use the service suffix](folder-file-naming.md)
- [Source files keep one primary responsibility](source-files-stay-cohesive.md)
