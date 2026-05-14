type CompanyService = {
  getCompany(id: string): Promise<{ id: string; name: string } | null>;
};

export function createCompanyRoutes(companyService: CompanyService) {
  return {
    async getCompany(request: Request): Promise<Response> {
      const id = new URL(request.url).searchParams.get("id");
      if (!id) return Response.json({ error: "Missing id" }, { status: 400 });

      const company = await companyService.getCompany(id);
      if (!company) return Response.json({ error: "Not found" }, { status: 404 });

      return Response.json({ company });
    },
  };
}
