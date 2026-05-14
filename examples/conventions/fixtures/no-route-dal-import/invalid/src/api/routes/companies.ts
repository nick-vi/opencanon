import { findCompanyById } from "../../db/dal/company";

export function createCompanyRoutes() {
  return {
    async getCompany(id: string): Promise<Response> {
      const company = await findCompanyById(id);
      return Response.json({ company });
    },
  };
}
