import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/api/routes/company.ts", `
      export const response = {
        title: "company",
        label: "company",
        metric: "company",
      };
    `),
  ],
});
