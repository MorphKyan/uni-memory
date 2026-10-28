import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { deleteSchema, memorySelector, rejectSecrets, writeSchema, AppError } from './validation.js';
import { scopeSchema, scopeSql } from './scope.js';

export interface Memory {
  id: string; key: string; content: string; tags: string[]; pinned: boolean;
  namespace: string; type: 'preference' | 'fact' | 'decision' | 'status'; verification: 'confirmed' | 'pending';
  expires_at: string | null; version: number; deleted_at: string | null;
  [field: string]: unknown;
}
export const visible = "deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())";
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
export async function enqueue(client: PoolClient, id: string) {
  await client.query(`INSERT INTO index_jobs(memory_id) VALUES ($1)
    ON CONFLICT(memory_id) DO UPDATE SET attempts=0, failed=false, error_code=NULL, available_at=now()`, [id]);
}
async function sources(client: PoolClient, id: string) {
  return (await client.query('SELECT client_id, reference, excerpt, created_at FROM memory_sources WHERE memory_id=$1 ORDER BY created_at', [id])).rows;
}
async function snapshot(client: PoolClient, memory: Memory, actor: string) {
  const source = await sources(client, memory.id);
  await client.query('INSERT INTO memory_events(memory_id, version, client_id, snapshot) VALUES($1,$2,$3,$4)',
    [memory.id, memory.version, actor, JSON.stringify({ ...memory, sources: source })]);
}
export class Store {
  constructor(public pool: Pool) {}
  async get(input: unknown) {
    const select = memorySelector.parse(input);
    const result = await this.pool.query<Memory>(`SELECT * FROM memories WHERE ${select.id ? 'id=$1' : 'key=$1 AND namespace=$2'} AND ${visible}`,
      select.id ? [select.id] : [select.key, select.namespace]);
    const memory = result.rows[0];
    if (!memory) throw new AppError(404, 'memory_not_found');
    return { ...memory, sources: (await this.pool.query('SELECT client_id, reference, excerpt, created_at FROM memory_sources WHERE memory_id=$1 ORDER BY created_at', [memory.id])).rows };
  }
  async history(input: unknown) {
    const select = memorySelector.parse(input);
    const memory = (await this.pool.query('SELECT id FROM memories WHERE ' + (select.id ? 'id=$1' : 'key=$1 AND namespace=$2') + ' AND deleted_at IS NULL',
      select.id ? [select.id] : [select.key, select.namespace])).rows[0];
    if (!memory) throw new AppError(404, 'memory_not_found');
    return (await this.pool.query('SELECT version, client_id, snapshot, created_at FROM memory_events WHERE memory_id=$1 ORDER BY id', [memory.id])).rows;
  }
  async core(input: unknown) {
    const scope = scopeSql(scopeSchema.parse(input), 1);
    return (await this.pool.query<Memory>(`SELECT * FROM memories WHERE pinned AND ${visible} AND ${scope.sql} ORDER BY updated_at DESC LIMIT 50`, scope.values)).rows;
  }
  private async idempotent(actor: string, key: string, request: unknown, run: (client: PoolClient) => Promise<Record<string, unknown>>) {
    const hash = createHash('sha256').update(JSON.stringify(request)).digest('hex');
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`idem:${actor}:${key}`]);
      const prior = (await client.query('SELECT request_hash, result FROM idempotency WHERE client_id=$1 AND key=$2', [actor, key])).rows[0];
      if (prior) {
        if (prior.request_hash !== hash) throw new AppError(409, 'idempotency_key_reused');
        return prior.result as Record<string, unknown>;
      }
      const result = await run(client);
      const id = (result.memory as Memory | undefined)?.id ?? result.id;
      await client.query('INSERT INTO idempotency(client_id,key,request_hash,memory_id,result) VALUES($1,$2,$3,$4,$5)',
        [actor, key, hash, id, JSON.stringify(result)]);
      return result;
    });
  }
  async write(actor: string, input: unknown) {
    const data = writeSchema.parse(input);
    data.key = data.key.normalize('NFKC');
    data.content = data.content.normalize('NFC');
    data.tags = [...new Set(data.tags)].sort();
    rejectSecrets(data);
    return this.idempotent(actor, data.idempotency_key, { operation: 'write', ...data }, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [JSON.stringify(['memory', data.namespace, data.key])]);
      const old = (await client.query<Memory>('SELECT * FROM memories WHERE namespace=$1 AND key=$2 FOR UPDATE', [data.namespace, data.key])).rows[0];
      let memory: Memory;
      let status = 'created';
      if (old) {
        const same = old.content === data.content && JSON.stringify(old.tags) === JSON.stringify(data.tags)
          && old.type === data.type && old.verification === data.verification
          && old.pinned === data.pinned && (old.expires_at ? new Date(old.expires_at).toISOString() : null)
            === (data.expires_at ? new Date(data.expires_at).toISOString() : null);
        if ((data.expected_version !== undefined && data.expected_version !== old.version)
          || (!same && data.expected_version === undefined)) {
          return { status: 'conflict', memory: old };
        }
        if (same) { memory = old; status = 'merged'; }
        else {
          memory = (await client.query<Memory>(`UPDATE memories SET content=$2,tags=$3,pinned=$4,expires_at=$5,type=$6,verification=$7,
            version=version+1,updated_at=now() WHERE id=$1 RETURNING *`,
          [old.id, data.content, data.tags, data.pinned, data.expires_at, data.type, data.verification])).rows[0]!;
          status = 'updated';
        }
      } else {
        if (data.expected_version !== undefined) throw new AppError(409, 'version_without_memory');
        memory = (await client.query<Memory>('INSERT INTO memories(id,key,content,tags,pinned,expires_at,namespace,type,verification) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *',
          [randomUUID(), data.key, data.content, data.tags, data.pinned, data.expires_at, data.namespace, data.type, data.verification])).rows[0]!;
      }
      const addedSource = await client.query(`INSERT INTO memory_sources(memory_id,client_id,reference,excerpt) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING`,
        [memory.id, actor, data.source.reference, data.source.excerpt]);
      if (status !== 'merged' || addedSource.rowCount) await snapshot(client, memory, actor);
      if (status !== 'merged') await enqueue(client, memory.id);
      return { status, memory: { ...memory, sources: await sources(client, memory.id) } };
    });
  }
  async delete(actor: string, input: unknown) {
    const data = deleteSchema.parse(input);
    return this.idempotent(actor, data.idempotency_key, { operation: 'delete', ...data }, async client => {
      const memory = (await client.query<Memory>('SELECT * FROM memories WHERE id=$1 FOR UPDATE', [data.id])).rows[0];
      if (!memory || memory.deleted_at) throw new AppError(404, 'memory_not_found');
      if (memory.version !== data.expected_version) return { status: 'conflict', memory };
      await client.query('DELETE FROM memory_events WHERE memory_id=$1', [data.id]);
      await client.query('DELETE FROM memory_sources WHERE memory_id=$1', [data.id]);
      const result = { status: 'deleted', id: data.id };
      await client.query('UPDATE idempotency SET result=$2 WHERE memory_id=$1', [data.id, JSON.stringify(result)]);
      await client.query(`UPDATE memories SET key=NULL,content=NULL,tags='{}',pinned=false,expires_at=NULL,
        namespace='global',type='fact',verification='pending',
        version=version+1,deleted_at=now(),updated_at=now() WHERE id=$1`, [data.id]);
      await enqueue(client, data.id);
      return result;
    });
  }
}
