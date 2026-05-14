# Architecture

## DAL

DAL modules are thin persistence adapters.

Rules:

- DAL functions accept simple input values or typed insert/update objects.
- The optional transaction/client parameter is last.
- Not-found reads return `null`.
- Batch functions return early for empty input.
- Business rules stay in services, not DAL.

## Services

Services compose workflows and business decisions.

Rules:

- Call DAL functions for persistence.
- Pass transaction/client parameters through multi-step workflows.
- Name service implementation files with the `*.service.ts` or `*.service.tsx` suffix.
- Do not import DB clients for ordinary reads or writes.
- Do not build table queries in services.
- Keep HTTP/request concerns out of services.

## Imports

Imports should make ownership clear.

Rules:

- Use same-folder relative imports for colocated private helpers.
- Use approved aliases or barrels for cross-layer dependencies.
- Avoid imports that climb multiple parent folders.
- Do not deep-import another layer's private implementation files.

## Framework Packages

OpenCanon framework packages depend inward.

Rules:

- Core owns shared contracts, schemas, context loading, validation runtime, and filesystem-safe primitives.
- Validator factories depend on core and local validator helpers.
- The engine TypeScript wrapper depends on core and the Rust engine binary.
- The daemon depends on core, engine, and validators.
- The CLI depends on core and daemon.
- UI source talks to daemon APIs and local DTOs instead of importing framework runtime packages.
- Shared contracts move into core rather than importing upward from daemon, CLI, engine, validators, or UI.

## API Routes

Route handlers are HTTP adapters. They validate input, call services, and serialize responses.

Rules:

- Validate params, query, and body at the route boundary.
- Use services for workflows and business decisions.
- Do not call DAL modules directly from route handlers.
- Keep response DTO mapping explicit.
- Keep route files organized by resource.

## Schemas

Schemas describe boundaries.

Rules:

- Contract schemas describe external request/response DTOs.
- Database schemas describe persistence tables and relations.
- Do not import database table definitions into public contract modules.
- Prefer one canonical exported schema per boundary concept.
