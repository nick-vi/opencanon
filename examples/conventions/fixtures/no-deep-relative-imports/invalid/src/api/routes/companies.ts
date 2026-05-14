import { findCompanyById } from "../../db/dal/company.ts";

export async function getCompany(id: string) {
  return findCompanyById(id);
}
