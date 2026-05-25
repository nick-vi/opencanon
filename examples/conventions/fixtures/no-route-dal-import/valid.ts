import { defineFixture } from "@opencanon/core/testing";

export default defineFixture({
  files: ({ file }) => [
    file.ts("src/api/routes/companies.ts", `
      type CompanyService = {
        getCompany(id: string): Promise<{ id: string; name: string } | null>;
      };

      export function createCompanyRoutes(companyService: CompanyService) {
        return {
          async getCompany(id: string): Promise<Response> {
            const company = await companyService.getCompany(id);
            return Response.json({ company });
          },
        };
      }
    `),
  ],
});
