# Security

## Security

Security-sensitive code keeps dangerous APIs and unchecked boundary inputs out of normal flows.

Rules:

- Validate input at API and integration boundaries.
- Prefer allowlisted parsing and typed schemas over ad hoc checks.
- Keep authorization and permission changes linked to impact surfaces.
- Route external security tools through structured diagnostics when a project opts in.

## Hardcoded Secrets And Config

Secrets and environment-specific configuration stay out of source literals.

Rules:

- Do not commit API keys, bearer tokens, passwords, client secrets, private keys, or high-entropy credential strings.
- Keep real secret values in a secret manager or environment variable.
- Route URLs, hosts, and ports through named configuration unless they are documented local defaults or test fixtures.
- Allow placeholder values only when they cannot be mistaken for live credentials.
