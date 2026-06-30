# Impact

## Impact Surfaces

Impact surfaces describe code whose changes can affect domain behavior outside direct imports.

Rules:

- Persistent data, events, permissions, jobs, contracts, and high-risk domain logic can be declared as impact surfaces.
- Enforced impact surfaces must link docs and conventions.
- Agent-discovered impact notes stay proposed until reviewed.
- Sensitive changes must include the checks required by the surface policy.
