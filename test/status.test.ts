import assert from 'node:assert/strict';
import test from 'node:test';
import { MemoryStatus } from '../src/status.js';
import { collectionName, EmbeddingWorker, type Embedder, type EmbeddingStatus } from '../src/embedding.js';
import type { MemoryStatistics, Store } from '../src/store.js';
import type { Qdrant } from '../src/qdrant.js';

const input = { namespaces: ['global'] };
function fixture() {
  const embedder: Embedder & { status: EmbeddingStatus } = {
    model: 'synthetic-status', dtype: 'test', dimensions: 3, status: { state: 'ready', error_code: null },
    embed: async () => { throw new Error('status 不得触发推理'); },
  };
  const statistics: MemoryStatistics = {
    memories: { active: 2, pending: 1, pinned: 1, expired: 0, last_updated_at: null },
    index: { total: 3, indexed: 3, queued: 0, failed: 0, active_generation: collectionName(embedder) },
  };
  const store = { statistics: async () => statistics } as unknown as Store;
  const qdrant = { request: async () => ({ collections: [{ name: collectionName(embedder) }] }) } as unknown as Qdrant;
  return { embedder, statistics, store, qdrant };
}

test('status 区分模型最近观测、未配置与加载状态，查询不执行推理', async () => {
  const { store, qdrant, embedder } = fixture();
  const service = new MemoryStatus(store, qdrant, embedder);
  for (const state of ['unloaded', 'loading', 'failed', 'ready'] as const) {
    embedder.status = { state, error_code: state === 'failed' ? 'model_files_not_found' : null };
    const result = await service.get(input);
    assert.equal(result.embedding.state, state);
    assert.equal(result.embedding.error_code, embedder.status.error_code);
    assert.equal(result.status, state === 'ready' ? 'ok' : 'degraded');
    assert.equal(result.search_mode, state === 'ready' ? 'hybrid' : 'keyword');
    assert(result.uptime_seconds >= 0);
    assert(Number.isFinite(Date.parse(result.checked_at)));
  }
  assert.equal((await new MemoryStatus(store, qdrant).get(input)).embedding.state, 'disabled');
  Reflect.deleteProperty(embedder, 'status');
  assert.equal((await service.get(input)).embedding.state, 'unknown');
});

test('status 核对集合与版本，积压和失败任务使总体状态降级', async () => {
  const { store, qdrant, embedder, statistics } = fixture();
  const service = new MemoryStatus(store, qdrant, embedder);
  statistics.index.active_generation = 'old-collection';
  assert.equal((await service.get(input)).search_mode, 'keyword');
  statistics.index.active_generation = collectionName(embedder);
  for (const field of ['queued', 'failed', 'indexed'] as const) {
    const previous = statistics.index[field];
    statistics.index[field] = field === 'indexed' ? 2 : 1;
    const result = await service.get(input);
    assert.equal(result.status, 'degraded');
    assert.equal(result.search_mode, 'hybrid');
    statistics.index[field] = previous;
  }
  qdrant.request = async () => ({ collections: [] });
  const missing = await service.get(input);
  assert.equal(missing.qdrant, 'ok');
  assert.equal(missing.index?.collection_exists, false);
  assert.equal(missing.search_mode, 'keyword');
  assert.equal(missing.status, 'degraded');
});

test('status 局部依赖失败保留可用统计，不泄露原始错误；非法输入先拒绝', async () => {
  const { store, qdrant, embedder } = fixture();
  const service = new MemoryStatus(store, qdrant, embedder);
  let probes = 0;
  qdrant.request = async () => { probes++; throw new Error('synthetic-private-upstream'); };
  const fallback = await service.get(input);
  assert.equal(fallback.status, 'degraded');
  assert.equal(fallback.search_mode, 'keyword');
  assert.equal(fallback.qdrant, 'unavailable');
  assert.equal(fallback.memories?.active, 2);
  store.statistics = async () => { throw new Error('synthetic-private-database'); };
  const unavailable = await service.get(input);
  assert.equal(unavailable.status, 'unavailable');
  assert.equal(unavailable.search_mode, 'unavailable');
  assert.equal(unavailable.memories, null);
  assert.equal(unavailable.index, null);
  assert(!JSON.stringify(unavailable).includes('synthetic-private'));
  for (const invalid of [{}, { namespaces: [] }, { ...input, include_descendants: 'false' }, { ...input, client_id: 'fake' }]) {
    await assert.rejects(service.get(invalid));
  }
  assert.equal(probes, 2);
});

test('真实推理线程未使用时保持 unloaded，退出后报告固定失败码', async () => {
  const worker = new EmbeddingWorker('gemma2');
  try { assert.deepEqual(worker.status, { state: 'unloaded', error_code: null }); }
  finally { await worker.close(); }
  assert.deepEqual(worker.status, { state: 'failed', error_code: 'embedding_worker_closed' });
});
