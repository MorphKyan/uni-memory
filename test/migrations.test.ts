import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { migrate, pendingMigrations, readMigrations } from '../src/migrations.js';
import { createPool } from '../src/db.js';
import type { Pool } from 'pg';

test('缺少连接配置时拒绝隐式连接本机数据库', () => {
  assert.throws(() => createPool(undefined), /DATABASE_URL/);
  assert.throws(() => createPool('  '), /DATABASE_URL/);
});

test('迁移失败会回滚，回滚失败会丢弃连接', async () => {
  for (const rollbackFails of [false, true]) {
    const calls: string[] = [];
    let released: boolean | undefined;
    const client = {
      async query(sql: string) {
        calls.push(sql);
        if (sql === 'BROKEN SQL' || (rollbackFails && sql === 'ROLLBACK')) {
          throw new Error('模拟数据库错误');
        }
        return { rows: [] };
      },
      release(discard: boolean) { released = discard; },
    };
    const pool = { connect: async () => client } as unknown as Pool;
    await assert.rejects(migrate(pool, [{ name: '0001_failure.sql', sql: 'BROKEN SQL', checksum: 'hash' }]));
    assert.equal(calls[0], 'BEGIN');
    assert.equal(calls[1], 'SELECT pg_advisory_xact_lock(170041, 1)');
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.equal(calls.includes('COMMIT'), false);
    assert.equal(calls.some(sql => sql.startsWith('INSERT')), false);
    assert.equal(released, rollbackFails);
  }
});

test('迁移成功后在同一事务内记录校验值并提交', async () => {
  const calls: { sql: string; values?: unknown[] }[] = [];
  let released = false;
  const pool = { connect: async () => ({
    async query(sql: string, values?: unknown[]) {
      calls.push({ sql, values });
      return { rows: [] };
    },
    release(discard: boolean) { assert.equal(discard, false); released = true; },
  }) } as unknown as Pool;
  const file = { name: '0001_first.sql', sql: 'SELECT 1', checksum: 'hash' };
  assert.deepEqual(await migrate(pool, [file]), [file.name]);
  assert.deepEqual(calls.at(-2)?.values, [file.name, file.checksum]);
  assert.equal(calls.at(-1)?.sql, 'COMMIT');
  assert.equal(released, true);
});

test('迁移按序加载，检测篡改、删除、插队和重复版本', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uni-memory-migrations-'));
  const url = pathToFileURL(directory + sep);
  try {
    await writeFile(join(directory, '0002_second.sql'), 'SELECT 2;');
    await writeFile(join(directory, '0001_first.sql'), 'SELECT 1;');
    const files = await readMigrations(url);
    assert.deepEqual(files.map(file => file.name), ['0001_first.sql', '0002_second.sql']);
    assert.deepEqual(pendingMigrations(files, []), files);
    assert.deepEqual(pendingMigrations(files, files), []);
    assert.deepEqual(pendingMigrations(files, [files[0]!]), [files[1]]);
    assert.throws(() => pendingMigrations(files, [{ name: files[0]!.name, checksum: 'changed' }]), /修改或删除/);
    assert.throws(() => pendingMigrations([], files), /修改或删除/);
    assert.throws(() => pendingMigrations(files, [files[1]!]), /之后/);
    await writeFile(join(directory, '0001_duplicate.sql'), 'SELECT 3;');
    await assert.rejects(readMigrations(url), /重复/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
