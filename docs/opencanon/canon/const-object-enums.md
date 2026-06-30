# Use const objects instead of native TypeScript enums

Convention id: `const-object-enums`.
Render style: `reference`.

## Rule

Rule: Enum-like values use JavaScript const objects plus a derived union type instead of native TypeScript enums.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx}`
- file glob `tests/**/*.{ts,tsx}`
- file glob `packages/*/src/**/*.{ts,tsx}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Const objects are plain JavaScript and avoid TypeScript enum runtime semantics. The pattern keeps value casing and type naming visible to agents and reviewers.

## Examples

Example 1:
Note: export const CompanyStatus = { ACTIVE: "active" } as const;

Example 2:
Note: export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];

## Related impact surfaces

No related impact surfaces are recorded.

## Related conventions

- [no-native-enums](opencanon://conventions/no-native-enums)
- [repeated-domain-literals](opencanon://conventions/repeated-domain-literals)
