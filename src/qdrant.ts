import type { Config } from './config.js';
import type { MemoryScope } from './scope.js';
import type { Memory } from './store.js';

export class Qdrant {
  constructor(private cfg: Pick<Config, 'qdrantUrl' | 'qdrantKey'>) {}
  async request(path: string, method = 'GET', body?: unknown): Promise<any> {
    const response = await fetch(`${this.cfg.qdrantUrl.replace(/\/$/, '')}${path}`, {
      method, headers: { 'content-type': 'application/json', ...(this.cfg.qdrantKey ? { 'api-key': this.cfg.qdrantKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw new Error(`qdrant_${response.status}`);
    return (await response.json() as { result: unknown }).result;
  }
  async ensure(name: string, dimensions: number) {
    let payloadSchema: Record<string, unknown> = {};
    try {
      const collection = await this.request(`/collections/${name}`);
      payloadSchema = collection.payload_schema ?? {};
      const vectors = collection.config?.params?.vectors;
      if (vectors?.size !== dimensions || vectors?.distance !== 'Cosine') throw new Error('qdrant_dimension_mismatch');
    } catch (error) {
      if (!(error instanceof Error) || error.message !== 'qdrant_404') throw error;
      await this.request(`/collections/${name}`, 'PUT', { vectors: { size: dimensions, distance: 'Cosine' } });
    }
    for (const field of ['namespace', 'namespace_paths', 'tags', 'type', 'verification']) {
      if (!payloadSchema[field]) await this.request(`/collections/${name}/index?wait=true`, 'PUT', { field_name: field, field_schema: 'keyword' });
    }
  }
  async upsert(name: string, memory: Memory, vector: number[]) {
    const { id, version, namespace, tags, type, verification } = memory;
    const namespace_paths = namespace.split('/').map((_, i, parts) => parts.slice(0, i + 1).join('/'));
    await this.request(`/collections/${name}/points?wait=true`, 'PUT', {
      points: [{ id, vector, payload: { version, namespace, namespace_paths, tags, type, verification } }],
    });
  }
  async delete(name: string, id: string) {
    try { await this.request(`/collections/${name}/points/delete?wait=true`, 'POST', { points: [id] }); }
    catch (error) { if (!(error instanceof Error) || error.message !== 'qdrant_404') throw error; }
  }
  async search(name: string, vector: number[], limit: number, scope: MemoryScope): Promise<{ id: string; payload: { version: number } }[]> {
    const must: unknown[] = [
      { key: scope.include_descendants ? 'namespace_paths' : 'namespace', match: { any: scope.namespaces } },
      ...scope.tags.map(tag => ({ key: 'tags', match: { value: tag } })),
    ];
    if (scope.type) must.push({ key: 'type', match: { value: scope.type } });
    if (scope.verification) must.push({ key: 'verification', match: { value: scope.verification } });
    return this.request(`/collections/${name}/points/search`, 'POST', { vector, limit, with_payload: true, filter: { must } });
  }
}
