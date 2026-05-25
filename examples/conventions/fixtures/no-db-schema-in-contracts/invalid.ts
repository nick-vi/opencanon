import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/contracts/company.ts", `
      import { companies } from "../db/schema/company";

      export type CompanyDto = typeof companies.$inferSelect;
    `),
    file.ts("src/db/schema/company.ts", `
      export const companies = {
        $inferSelect: {},
      };
    `),
  ],
});
