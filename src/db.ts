import pg, { type Pool, type PoolClient } from 'pg';

export function createPool(connectionString: string | undefined) {
  if (!connectionString?.trim()) {
    throw new Error('请设置 DATABASE_URL');
  }
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, max: 10, statement_timeout: 15000 });
}

export async function transaction<T>(pool: Pool, run: (client: PoolClient) => Promise<T>) {
  const client = await pool.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    const result = await run(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { broken = true; }
    throw error;
  } finally { client.release(broken); }
}
