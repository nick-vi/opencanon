import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/company.ts", `
      const CompanyTable = "companies";

      export function loadCompany(id: string) {
        return { table: CompanyTable, id };
      }
    `),
  ],
});
