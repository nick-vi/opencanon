import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/contracts/company.ts", `
      export const CompanyStatus = {
        ACTIVE: "active",
        ARCHIVED: "archived",
      } as const;

      export type CompanyStatus = (typeof CompanyStatus)[keyof typeof CompanyStatus];
    `),
  ],
});
