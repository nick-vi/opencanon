import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/services/company.ts", `
      // @shim @owner platform @replacement getCompanyNameV2 @remove-by 2026-12-31
      export function getCompanyName() {
        return "Acme";
      }
    `),
  ],
});
