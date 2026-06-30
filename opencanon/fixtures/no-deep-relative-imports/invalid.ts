import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/api/routes/companies.ts", `
      import { findCompanyById } from "../../db/dal/company.ts";

      export async function getCompany(id: string) {
        return findCompanyById(id);
      }
    `),
    file.ts("src/db/dal/company.ts", `
      export async function findCompanyById(id: string): Promise<{ id: string }> {
        return { id };
      }
    `),
  ],
});
