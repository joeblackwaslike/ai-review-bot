export const db = {
  async insert(table: string, row: unknown): Promise<unknown> {
    return { table, row };
  },
};
