declare function db(): {
  query<T>(sql: string, params: unknown[]): Promise<T[]>;
};

export async function findCompanyById(id: string) {
  return db().query("select id from companies where id = ?", [id]);
}
