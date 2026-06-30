import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.json("docs/opencanon/impact-surfaces.json", [
        {
          "id": "company-read-model",
          "applies": [
            "src/db/dal/company.ts"
          ],
          "changePolicy": {
            "requiresApproval": true
          },
          "docs": [
            "docs/opencanon/canon/impact.md#impact-surfaces"
          ],
          "conventionIds": [
            "impact-surfaces-current"
          ]
        }
      ]),
    file.ts("src/db/dal/company.ts", `
      export function findCompanyById(id: string) {
        return { id };
      }
    `),
  ],
});
