const CompanyTable = "companies";

function normalizeCompany(id: string) {
  return id.trim().toLowerCase();
}

export function loadCompany(id: string) {
  const normalized = normalizeCompany(id);
  return { table: CompanyTable, normalized };
}
