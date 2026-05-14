type DatabaseClient = {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
};

declare function db(): DatabaseClient;

export async function findCompanyById(id: string, tx?: DatabaseClient) {
  const client = tx ?? db();
  return client.query("select id from companies where id = ?", [id]);
}
