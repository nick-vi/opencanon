type DatabaseClient = {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
};

type Company = {
  id: string;
  name: string;
};

declare function db(): DatabaseClient;

export async function findCompanyById(id: string, tx?: DatabaseClient): Promise<Company | null> {
  const client = tx ?? db();
  const rows = await client.query<Company>("select id, name from companies where id = ?", [id]);
  return rows[0] ?? null;
}
