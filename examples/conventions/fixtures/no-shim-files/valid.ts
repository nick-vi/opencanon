import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/services/company.ts", `
      export function getCompanyName() {
        return "Acme";
      }
    `),
  ],
});
