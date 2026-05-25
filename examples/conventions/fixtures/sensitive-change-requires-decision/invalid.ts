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
            "requiresDecision": true
          },
          "docs": [
            "examples/conventions/docs/opencanon/canon/impact.md#impact-surfaces"
          ],
          "decisionIds": [
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
