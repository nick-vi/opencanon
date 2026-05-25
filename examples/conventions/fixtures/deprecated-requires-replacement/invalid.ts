import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/services/company.ts", `
      // @deprecated use the replacement service
      export function getCompanyName() {
        return "Acme";
      }
    `),
  ],
});
