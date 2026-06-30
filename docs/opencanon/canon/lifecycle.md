# Lifecycle

## Comments

Comments describe current intent.

Rules:

- Explain why current code is non-obvious.
- Remove stale notes about legacy, deprecated, shim, or backward-compatibility paths when touching that flow.
- Prefer refactoring stale paths over documenting why they remain.
- Keep suppression comments specific and justified.

## Type Patterns

Enum-like values use const objects.

Rules:

- Do not use native `enum` or `const enum`.
- Use PascalCase object names.
- Use SCREAMING_SNAKE_CASE keys.
- Use string literal values.
- Export a matching derived union type.

## Deprecations

Internal deprecations and shims require explicit lifecycle metadata.

Rules:

- Prefer updating touched code to the current path instead of adding a shim.
- Any allowed shim or deprecation must name an owner, replacement, and removal trigger.
- Public boundary compatibility exceptions must link a convention.
