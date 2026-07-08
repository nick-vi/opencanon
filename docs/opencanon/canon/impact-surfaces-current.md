# Impact surfaces describe sensitive downstream effects

## Rule

Sensitive files and domain resources are linked through impact surfaces so agents can see downstream effects before changing them.

## Applies to

- `src/**/*.{ts,tsx,py}`
- `tests/**/*.{ts,tsx,py}`

## Why

Import graphs miss domain dependencies such as data, events, jobs, permissions, and external contracts. Agents need explicit risk context before changing sensitive surfaces.

## Related impact surfaces

- [company-read-model](opencanon://impact-surfaces/company-read-model)

## Related conventions

- [sensitive-change-requires-approval](opencanon://conventions/sensitive-change-requires-approval)
