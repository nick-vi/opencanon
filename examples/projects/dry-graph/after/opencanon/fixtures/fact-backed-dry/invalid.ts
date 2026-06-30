import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/company.ts", `
      export function loadCompany(id: string) {
        return findByStatus(id, "active");
      }

      export function activeCompanyFilter() {
        return { status: "active" };
      }

      export function isActiveCompany(status: string) {
        return status === "active";
      }
    `),
  ],
});
