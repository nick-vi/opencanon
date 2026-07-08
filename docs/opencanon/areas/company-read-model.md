# Example Company Read Model

## Summary

The example company read model dogfoods service-boundary conventions without representing OpenCanon product behavior.

## Ownership

Files: src/db/dal/company.ts, src/api/routes/companies.ts, tests/unit/company.test.ts
Endpoints: GET /companies?id (route)
Resources: db:companies

## Impact surfaces

- [Company read model](../canon/impact.md#impact-surfaces)

## Checks

- `company-unit-tests` test `tests/unit/company.test.ts`
- `project-validation` command `npm run opencanon -- validate --project`

## Stories

Story `read-company-by-id`: as developer, I want company reads to go through the route/service/DAL boundary, so customer-visible company data stays stable when persistence internals change.
- route handlers do not import DAL modules
- DAL reads return null for missing companies
Checks: `company-unit-tests`, `project-validation`

## Behaviors

Behavior `protects-company-contract`: route handler reads a company by id; the response contract is isolated from database schema internals.
Checks: `company-unit-tests`

## Governance

- convention [Routes call services instead of DAL modules](../canon/no-route-dal-import.md)
- convention [Services compose DAL instead of direct DB clients](../canon/service-db-boundary.md)
- convention [Impact surfaces describe sensitive downstream effects](../canon/impact-surfaces-current.md)
