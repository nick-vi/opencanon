import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.json("docs/opencanon/impact-surfaces.json", []),
    file.ts("src/services/company.ts", `
      export function getCompanyName() {
        return "Acme";
      }
    `),
  ],
});
