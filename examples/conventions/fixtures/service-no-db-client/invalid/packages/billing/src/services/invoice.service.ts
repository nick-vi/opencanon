import { db } from "../db/client.ts";

export async function getInvoice(id: string) {
  const rows = await db().select();
  return rows.find((row) => row.id === id) ?? null;
}
