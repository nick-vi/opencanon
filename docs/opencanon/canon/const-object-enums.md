# Use const objects instead of native TypeScript enums

## Rule

Enum-like values use JavaScript const objects plus a derived union type instead of native TypeScript enums.

## Applies to

- `src/**/*.{ts,tsx}`
- `tests/**/*.{ts,tsx}`
- `packages/*/src/**/*.{ts,tsx}`

## Why

Const objects are plain JavaScript and avoid TypeScript enum runtime semantics. The pattern keeps value casing and type naming visible to agents and reviewers.

## Examples

- export const CompanyStatus = { ACTIVE: "active" } as const;

- export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];

## Related conventions

- [no-native-enums](opencanon://conventions/no-native-enums)
- [repeated-domain-literals](opencanon://conventions/repeated-domain-literals)
