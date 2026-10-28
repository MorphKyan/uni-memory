import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { deleteSchema, memorySelector, rejectSecrets, writeSchema, AppError, namespacesSchema, listSchema, decodeListCursor } from './validation.js';
import { scopeSchema, scopeSql, type MemoryScope } from './scope.js';
import { transaction } from './db.js';

export interface Memory {
  id: string; key: string; content: string; tags: string[]; pinned: boolean;
  namespace: string; type: 'preference' | 'fact' | 'decision' | 'status'; verification: 'confirmed' | 'pending';
  expires_at: string | null; version: number; deleted_at: string | null;
}
export const visible = "deleted_at IS NULL AND (expires_at IS NULL OR expires_at > now())";
export interface MemoryStatistics {
  memories: { active: number; pending: number; pinned: number; expired: number; last_updated_at: string | null };
  index: { total: number; indexed: number; queued: number; failed: number; active_generation: string | null };
}
async function enqueue(client: PoolClient, id: string) {
  await client.query(`INSERT INTO index_jobs(memory_id) VALUES ($1)
    ON CONFLICT(memory_id) DO UPDATE SET attempts=0, failed=false, error_code=NULL, available_at=now()`, [id]);
}
async function sources(client: Pool | PoolClient, id: string) {
  return (await client.query('SELECT client_id, reference, excerpt, created_at FROM memory_sources WHERE memory_id=$1 ORDER BY created_at', [id])).rows;
}
export class Store {
  constructor(public pool: Pool) {}
  async statistics(data: MemoryScope, generation: string | null) {
    const scope = scopeSql(data, 1);
    // 同一 SQL 快照内统计；记忆范围由调用方指定，索引与任务反映整个实例。
    return (await this.pool.query<MemoryStatistics>(`WITH scoped AS (
      SELECT * FROM memories WHERE deleted_at IS NULL AND ${scope.sql}
    ), valid AS (SELECT id,version FROM memories WHERE ${visible})
    SELECT (SELECT json_build_object(
      'active',count(*) FILTER (WHERE expires_at IS NULL OR expires_at>now())::int,
      'pending',count(*) FILTER (WHERE (expires_at IS NULL OR expires_at>now()) AND verification='pending')::int,
      'pinned',count(*) FILTER (WHERE (expires_at IS NULL OR expires_at>now()) AND pinned)::int,
      'expired',count(*) FILTER (WHERE expires_at<=now())::int,
      'last_updated_at',max(updated_at)) FROM scoped) AS memories,
      (SELECT json_build_object('total',count(*)::int,
        'indexed',count(*) FILTER (WHERE e.version=m.version)::int,
        'queued',(SELECT count(*)::int FROM index_jobs WHERE NOT failed),
        'failed',(SELECT count(*)::int FROM index_jobs WHERE failed),
        'active_generation',(SELECT name FROM index_generations WHERE active))
      FROM valid m LEFT JOIN index_entries e ON e.memory_id=m.id AND e.generation=$6) AS index`,
    [...scope.values, generation])).rows[0]!;
  }
  async namespaces(input: unknown) {
    const { parent } = namespacesSchema.parse(input);
    const result = await this.pool.query<{ namespace: string; count: number }>(`SELECT namespace, count(*)::int AS count
      FROM memories WHERE ${visible} AND ($1::text IS NULL OR namespace=$1 OR left(namespace,length($1)+1)=$1||'/')
      GROUP BY namespace ORDER BY namespace COLLATE "C"`, [parent ?? null]);
    return { namespaces: result.rows };
  }
  async list(input: unknown) {
    const data = listSchema.parse(input);
    const scope = scopeSql(data, 1);
    const cursor = data.cursor ? decodeListCursor(data.cursor) : null;
    // 保留 PostgreSQL 的微秒精度，避免 JS Date 截断时间后重复返回上一页末条。
    const result = await this.pool.query<Memory & { cursor_created_at: string }>(`SELECT *,
      to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS cursor_created_at
      FROM memories WHERE ${visible} AND ${scope.sql}
      AND ($6::timestamptz IS NULL OR (created_at,id)>($6::timestamptz,$7::uuid))
      ORDER BY created_at,id LIMIT $8`, [...scope.values, cursor?.created_at ?? null, cursor?.id ?? null, data.limit + 1]);
    const page = result.rows.slice(0, data.limit);
    const last = page.at(-1);
    const next_cursor = result.rows.length > data.limit && last
      ? Buffer.from(JSON.stringify({ created_at: last.cursor_created_at, id: last.id })).toString('base64url') : null;
    return { memories: page.map(({ cursor_created_at, ...memory }) => memory), next_cursor };
  }
  async get(input: unknown) {
    const select = memorySelector.parse(input);
    const result = await this.pool.query<Memory>(`SELECT * FROM memories WHERE ${select.id ? 'id=$1' : 'key=$1 AND namespace=$2'} AND ${visible}`,
      select.id ? [select.id] : [select.key, select.namespace]);
    const memory = result.rows[0];
    if (!memory) throw new AppError(404, 'memory_not_found');
    return { ...memory, sources: await sources(this.pool, memory.id) };
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
    return (await this.pool.query<Memory>(`SELECT * FROM memories WHERE pinned AND ${visible} AND ${scope.sql} ORDER BY (key='overview') DESC, updated_at DESC, id LIMIT 50`, scope.values)).rows;
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
    if (data.key === 'overview') data.pinned = true;
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
      const result = { ...memory, sources: await sources(client, memory.id) };
      if (status !== 'merged' || addedSource.rowCount) {
        await client.query('INSERT INTO memory_events(memory_id, version, client_id, snapshot) VALUES($1,$2,$3,$4)',
          [memory.id, memory.version, actor, JSON.stringify(result)]);
      }
      if (status !== 'merged') await enqueue(client, memory.id);
      return { status, memory: result };
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
