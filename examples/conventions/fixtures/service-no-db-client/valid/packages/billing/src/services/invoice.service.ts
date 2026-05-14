import { findInvoiceById } from "../db/dal/invoice.ts";

export async function getInvoice(id: string) {
  return findInvoiceById(id);
}
