# Impact surfaces describe sensitive downstream effects

Convention id: `impact-surfaces-current`.
Render style: `reference`.

## Rule

Rule: Sensitive files and domain resources are linked through impact surfaces so agents can see downstream effects before changing them.

## Applies to

Kind: `files`
- file glob `src/**/*.{ts,tsx,py}`
- file glob `tests/**/*.{ts,tsx,py}`

## Runtime checks

No runtime checks are configured.

## Why

Rationale: Import graphs miss domain dependencies such as data, events, jobs, permissions, and external contracts. Agents need explicit risk context before changing sensitive surfaces.

## Examples

No examples are recorded.

## Related impact surfaces

- [company-read-model](opencanon://impact-surfaces/company-read-model)

## Related conventions

- [sensitive-change-requires-approval](opencanon://conventions/sensitive-change-requires-approval)
