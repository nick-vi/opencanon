import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/contracts/company.ts", `
      export type CompanyDto = {
        id: string;
        name: string;
      };
    `),
  ],
});
