import { db } from "../db/client.ts";

export async function getCompany(id: string) {
  const rows = await db().select().where({ id });
  return rows[0] ?? null;
}
