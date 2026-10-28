import type { Pool } from 'pg';
import { collectionName, type Embedder } from './embedding.js';
import type { Qdrant } from './qdrant.js';
import type { Memory } from './store.js';

export class Indexer {
  private stopped = false;
  private timer?: NodeJS.Timeout;
  private current?: Promise<void>;
  constructor(private pool: Pool, private qdrant: Qdrant, private embedder?: Embedder) {}
  start() {
    const tick = () => {
      if (this.stopped) return;
      this.current = this.tick().catch(() => { /* 依赖错误不输出请求或正文，任务状态可供查询。 */ });
      void this.current.finally(() => { if (!this.stopped) this.timer = setTimeout(tick, 1000); });
    };
    tick();
  }
  async stop() { this.stopped = true; clearTimeout(this.timer); await this.current; }
  async tick() {
    const client = await this.pool.connect();
    let locked = false;
    let inTransaction = false;
    let broken = false;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock(170041,2) AS locked')).rows[0].locked;
      if (!locked) return;
      const generation = this.embedder ? collectionName(this.embedder) : undefined;
      if (this.embedder) {
        await client.query(`WITH generation AS (
          INSERT INTO index_generations(name,model,dtype,dimensions) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING name
        ) INSERT INTO index_jobs(memory_id) SELECT id FROM memories WHERE EXISTS (SELECT 1 FROM generation)
          ON CONFLICT(memory_id) DO UPDATE SET attempts=0,failed=false,error_code=NULL,available_at=now()`,
        [generation, this.embedder.model, this.embedder.dtype, this.embedder.dimensions]);
      }
      const jobs = (await client.query(`SELECT j.memory_id FROM index_jobs j JOIN memories m ON m.id=j.memory_id
        WHERE NOT j.failed AND j.available_at<=now() AND ($1::boolean OR m.deleted_at IS NOT NULL) ORDER BY j.available_at LIMIT 1`, [!!this.embedder])).rows;
      for (const job of jobs) {
        try {
          const snapshot = (await client.query<Memory>('SELECT * FROM memories WHERE id=$1', [job.memory_id])).rows[0]!;
          if (!snapshot.deleted_at && generation) await this.qdrant.ensure(generation, this.embedder!.dimensions);
          const vector = !snapshot.deleted_at && this.embedder ? (await this.embedder.embed([snapshot.content]))[0] : undefined;
          await client.query('BEGIN'); inTransaction = true;
          const latest = (await client.query<Memory>('SELECT * FROM memories WHERE id=$1 FOR UPDATE', [job.memory_id])).rows[0]!;
          if (snapshot.version !== latest.version) { await client.query('ROLLBACK'); inTransaction = false; continue; }
          if (latest.deleted_at) {
            for (const row of (await client.query('SELECT name FROM index_generations')).rows) await this.qdrant.delete(row.name, latest.id);
            await client.query('DELETE FROM index_entries WHERE memory_id=$1', [latest.id]);
          } else if (generation && vector) {
            await this.qdrant.upsert(generation, latest, vector);
            await client.query(`INSERT INTO index_entries(generation,memory_id,version) VALUES($1,$2,$3)
              ON CONFLICT(generation,memory_id) DO UPDATE SET version=EXCLUDED.version`, [generation, latest.id, latest.version]);
          } else { await client.query('ROLLBACK'); inTransaction = false; continue; }
          await client.query('DELETE FROM index_jobs WHERE memory_id=$1', [latest.id]);
          await client.query('COMMIT'); inTransaction = false;
        } catch {
          if (inTransaction) { await client.query('ROLLBACK'); inTransaction = false; }
          await client.query(`UPDATE index_jobs SET attempts=attempts+1,failed=(attempts+1>=10),
            available_at=now()+least(3600,power(2,attempts+1)) * interval '1 second',error_code='index_failed' WHERE memory_id=$1`, [job.memory_id]);
        }
      }
      if (generation) {
        await this.qdrant.ensure(generation, this.embedder!.dimensions);
        await client.query('BEGIN'); inTransaction = true;
        await client.query('LOCK TABLE memories IN SHARE MODE');
        const missing = (await client.query(`SELECT 1 FROM memories m LEFT JOIN index_entries e ON e.memory_id=m.id AND e.generation=$1
          WHERE m.deleted_at IS NULL AND (e.version IS NULL OR e.version<>m.version) LIMIT 1`, [generation])).rowCount;
        if (!missing) {
          await client.query('UPDATE index_generations SET active=false WHERE active AND name<>$1', [generation]);
          await client.query('UPDATE index_generations SET active=true WHERE name=$1', [generation]);
        }
        await client.query('COMMIT'); inTransaction = false;
      }
    } finally {
      try {
        if (inTransaction) await client.query('ROLLBACK');
        if (locked) await client.query('SELECT pg_advisory_unlock(170041,2)');
      } catch { broken = true; }
      client.release(broken);
    }
  }
  async rebuild() {
    // 重新登记全部事实；现有集合仍可检索，切换仅在新集合完整后发生。
    await this.pool.query(`INSERT INTO index_jobs(memory_id) SELECT id FROM memories
      ON CONFLICT(memory_id) DO UPDATE SET attempts=0,failed=false,error_code=NULL,available_at=now()`);
  }
  async retry() { await this.pool.query("UPDATE index_jobs SET attempts=0,failed=false,error_code=NULL,available_at=now()"); }
}
