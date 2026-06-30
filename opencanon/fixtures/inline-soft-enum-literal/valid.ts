import { defineFixture } from "@opencanon/core/testing";

/**
 * Honest negative fixture (this validator declares `fixtures: "valid-only"`).
 *
 * The `--check-fixtures` harness materializes ephemeral files with NO ready type
 * producer, so the surrounding type of this comparison never resolves to a finite
 * literal set. The rule reads only producer-checked `surroundingType`, so it MUST
 * emit nothing here even though the compared value "active" has a declared named
 * source (CompanyStatus).
 *
 * The positive (flag) and conservatism paths are covered deterministically by
 * tests/inline-soft-enum-literal.test.ts via an injected `ready` provider.
 */
export default defineFixture({
  files: ({ file }) => [
    file.ts("src/status.ts", `
      export const CompanyStatus = {
        ACTIVE: "active",
        ARCHIVED: "archived",
      } as const;
      export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];

      export function isActive(status: CompanyStatus): boolean {
        return status === "active";
      }
    `),
  ],
});
