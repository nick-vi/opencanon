import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/contracts/company.ts", `
      export const CompanyStatus = {
        Active: "active",
        Archived: "archived",
      } as const;

      export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];
    `),
  ],
});
