import { collectionName, type Embedder } from './embedding.js';
import type { Qdrant } from './qdrant.js';
import { scopeSchema } from './scope.js';
import type { Store } from './store.js';

export class MemoryStatus {
  constructor(private store: Store, private qdrant: Qdrant, private embedder?: Embedder) {}
  async get(input: unknown) {
    const scope = scopeSchema.parse(input);
    const generation = this.embedder ? collectionName(this.embedder) : null;
    const [database, vectors] = await Promise.allSettled([
      this.store.statistics(scope, generation), this.qdrant.request('/collections'),
    ]);
    const statistics = database.status === 'fulfilled' ? database.value : null;
    const embedding = this.embedder ? {
      model: this.embedder.model, dtype: this.embedder.dtype, dimensions: this.embedder.dimensions,
      state: this.embedder.status?.state ?? 'unknown', error_code: this.embedder.status?.error_code ?? null,
    } : { model: null, dtype: null, dimensions: null, state: 'disabled', error_code: null };
    const collectionExists = vectors.status === 'fulfilled'
      && !!vectors.value?.collections?.some((collection: { name: string }) => collection.name === generation);
    const hybrid = !!statistics && embedding.state === 'ready' && collectionExists
      && statistics.index.active_generation === generation;
    return {
      status: !statistics ? 'unavailable' : hybrid && statistics.index.queued === 0
        && statistics.index.failed === 0 && statistics.index.indexed === statistics.index.total ? 'ok' : 'degraded',
      checked_at: new Date().toISOString(), version: '0.2.0', uptime_seconds: Math.floor(process.uptime()),
      scope, database: statistics ? 'ok' : 'unavailable', qdrant: vectors.status === 'fulfilled' ? 'ok' : 'unavailable',
      memories: statistics?.memories ?? null, embedding,
      index: statistics ? { ...statistics.index, target_generation: generation, collection_exists: collectionExists } : null,
      search_mode: !statistics ? 'unavailable' : hybrid ? 'hybrid' : 'keyword',
    };
  }
}
