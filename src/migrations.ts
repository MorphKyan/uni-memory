import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { transaction } from './db.js';

export interface Migration {
  name: string;
  sql: string;
  checksum: string;
}

export async function readMigrations(directory: URL): Promise<Migration[]> {
  const files = (await readdir(directory)).filter(name => name.endsWith('.sql')).sort();
  const versions = new Set<string>();
  return Promise.all(files.map(async name => {
    const version = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(name)?.[1];
    if (!version || versions.has(version)) {
      throw new Error(`迁移文件名无效或版本重复：${name}`);
    }
    versions.add(version);
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
}

export function pendingMigrations(migrations: Migration[], applied: { name: string; checksum: string }[]) {
  for (const previous of applied) {
    if (!migrations.some(file => file.name === previous.name && file.checksum === previous.checksum)) {
      throw new Error(`已执行的迁移被修改或删除：${previous.name}`);
    }
  }
  const pending = migrations.filter(file => !applied.some(row => row.name === file.name));
  const last = applied.map(row => row.name).sort().at(-1);
  if (last && pending.some(file => file.name < last)) {
    throw new Error('新增迁移必须排在已执行版本之后');
  }
  return pending;
}

export async function migrate(pool: Pool, migrations: Migration[]) {
  return transaction(pool, async client => {
    await client.query('SELECT pg_advisory_xact_lock(170041, 1)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY,
      checksum text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{ name: string; checksum: string }>(
      'SELECT name, checksum FROM schema_migrations ORDER BY name',
    );
    const pending = pendingMigrations(migrations, applied.rows);
    for (const file of pending) {
      await client.query(file.sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)',
        [file.name, file.checksum]);
    }
    return pending.map(file => file.name);
  });
}
