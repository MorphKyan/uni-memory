// 用已选 Gemma 2 验证实际推理到专用测试 Qdrant，不写生产事实。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import { randomUUID } from 'node:crypto';
import { createPool } from '../dist/src/db.js';
import { Store } from '../dist/src/store.js';
import { Qdrant } from '../dist/src/qdrant.js';
import { Search } from '../dist/src/search.js';
import { Indexer } from '../dist/src/indexer.js';
import { EmbeddingWorker } from '../dist/src/embedding.js';
const env = parseEnv(readFileSync('.env', 'utf8'));
function ip(service) {
  const id = execFileSync('docker', ['compose', '-p', 'uni-memory-test', '-f', 'compose.yaml', '-f', 'compose.test.yaml', 'ps', '-q', service], { encoding: 'utf8' }).trim();
  return Object.values(JSON.parse(execFileSync('docker', ['inspect', id], { encoding: 'utf8' }))[0].NetworkSettings.Networks)[0].IPAddress;
}
const pool = createPool(`postgresql://uni_memory:${env.POSTGRES_PASSWORD}@${ip('postgres')}:5432/uni_memory_test`);
const embedder = new EmbeddingWorker('gemma2', 'q4', './.cache/models');
try {
  const store = new Store(pool);
  const qdrant = new Qdrant({ qdrantUrl: `http://${ip('qdrant')}:6333`, qdrantKey: env.QDRANT_API_KEY });
  const result = await store.write('synthetic-model-smoke', { namespace: 'global', type: 'fact', verification: 'confirmed', key: 'smoke.phrase', content: '用于验证的虚构事实：小熊设备存放在蓝色书房。', source: { reference: 'synthetic:model-smoke' }, idempotency_key: randomUUID() });
  const indexer = new Indexer(pool, qdrant, embedder);
  await indexer.rebuild();
  for (let i = 0; i < 100 && (await pool.query('SELECT 1 FROM index_jobs')).rowCount; i++) await indexer.tick();
  assert.equal((await pool.query('SELECT 1 FROM index_jobs')).rowCount, 0);
  const found = await new Search(store, qdrant, embedder).search({ namespaces: ['global'], query: 'Where is the little bear device kept?', limit: 10 });
  assert.equal(found.degraded, false);
  assert(found.memories.some(memory => memory.id === result.memory.id));
  console.log('真实 Gemma 2 Q4 CPU 推理、Qdrant 写入、跨语言检索及权威版本回查通过。');
} finally { await embedder.close(); await pool.end(); }
