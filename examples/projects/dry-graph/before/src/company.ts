function normalizeCompany(id: string) {
  return id.trim().toLowerCase();
}

export function loadCompany(id: string) {
  const normalized = normalizeCompany(id);
  return { table: "companies", normalized };
}

export function fetchCompany(id: string) {
  const normalized = normalizeCompany(id);
  return { table: "companies", normalized };
}
