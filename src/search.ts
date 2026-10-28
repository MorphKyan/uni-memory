import { searchSchema } from './validation.js';
import type { Store, Memory } from './store.js';
import { visible } from './store.js';
import type { Embedder } from './embedding.js';
import type { Qdrant } from './qdrant.js';
import { scopeSql } from './scope.js';

export function fuse(lists: string[][], limit: number) {
  const scores = new Map<string, number>();
  for (const list of lists) for (const [index, id] of [...new Set(list)].entries()) scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1));
  return [...scores].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, limit).map(([id]) => id);
}
export class Search {
  constructor(private store: Store, private qdrant: Qdrant, private embedder?: Embedder) {}
  async search(input: unknown) {
    const data = searchSchema.parse(input);
    const escaped = data.query.replace(/[\\%_]/g, '\\$&');
    const lexicalScope = scopeSql(data, 3);
    const lexical = (await this.store.pool.query<Pick<Memory, 'id' | 'version'>>(`SELECT id,version FROM memories WHERE ${visible} AND ${lexicalScope.sql}
      AND (content ILIKE $2 OR key ILIKE $2 OR similarity(content,$1)>0.08)
      ORDER BY (key=$1) DESC,(content ILIKE $2) DESC,similarity(content,$1) DESC,updated_at DESC LIMIT 100`,
    [data.query, `%${escaped}%`, ...lexicalScope.values])).rows;
    let degraded = !this.embedder;
    let reason: string | null = this.embedder ? null : 'embedding_not_configured';
    let vectorHits: { id: string; payload: { version: number } }[] = [];
    if (this.embedder) {
      try {
        const generation = (await this.store.pool.query('SELECT name,model,dtype FROM index_generations WHERE active')).rows[0];
        if (!generation || generation.model !== this.embedder.model || generation.dtype !== this.embedder.dtype) throw new Error('index_not_ready');
        let timer: NodeJS.Timeout | undefined;
        const vectors = await Promise.race([
          this.embedder.embed([data.query], true),
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('vector_timeout')), 5000); }),
        ]).finally(() => clearTimeout(timer));
        vectorHits = await this.qdrant.search(generation.name, vectors[0]!, 100, data);
      } catch { degraded = true; reason = 'vector_unavailable'; }
    }
    const candidates = [...new Set([...lexical.map(row => row.id), ...vectorHits.map(row => row.id)])];
    if (!candidates.length) return { memories: [], degraded, reason };
    const currentScope = scopeSql(data, 2);
    const current = (await this.store.pool.query<Memory>(`SELECT * FROM memories WHERE id=ANY($1::uuid[]) AND ${visible} AND ${currentScope.sql}`, [candidates, ...currentScope.values])).rows;
    const byId = new Map(current.map(row => [row.id, row]));
    const vectorIds = vectorHits.filter(hit => byId.get(hit.id)?.version === hit.payload?.version).map(hit => hit.id);
    const ids = fuse([lexical.filter(row => byId.get(row.id)?.version === row.version).map(row => row.id), vectorIds], data.limit);
    return { memories: ids.map(id => byId.get(id)!), degraded, reason };
  }
}
