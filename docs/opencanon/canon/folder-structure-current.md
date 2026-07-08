# Folders use approved responsibility names

Convention id: `folder-structure-current`.
Render style: `reference`.

## Rule

Rule: Folders should communicate ownership and layer responsibility instead of becoming dumping grounds.

## Applies to

Kind: `files`
- file glob `src/**`
- file glob `tests/**`
- file glob `packages/*/src/**`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Agents copy folder names they see. Ambiguous folders make ownership and import direction harder to infer.

## Examples

No examples are recorded.

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [no-dumpster-folders](opencanon://conventions/no-dumpster-folders)
- [folder-file-naming](opencanon://conventions/folder-file-naming)
- [source-files-stay-cohesive](opencanon://conventions/source-files-stay-cohesive)
