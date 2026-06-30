import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/api/routes/companies.ts", `
      import { findCompanyById } from "../../db/dal/company";

      export function createCompanyRoutes() {
        return {
          async getCompany(id: string): Promise<Response> {
            const company = await findCompanyById(id);
            return Response.json({ company });
          },
        };
      }
    `),
  ],
});
