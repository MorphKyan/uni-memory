import pg from 'pg';

export function createPool(connectionString: string | undefined) {
  if (!connectionString?.trim()) {
    throw new Error('请设置 DATABASE_URL');
  }
  return new pg.Pool({ connectionString, connectionTimeoutMillis: 5000, max: 10, statement_timeout: 15000 });
}
