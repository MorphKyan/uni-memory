import assert from 'node:assert/strict';
import test, { before, after } from 'node:test';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createPool } from '../src/db.js';
import { migrate, readMigrations } from '../src/migrations.js';
import { Store } from '../src/store.js';
import { Search } from '../src/search.js';
import { Qdrant } from '../src/qdrant.js';
import { Indexer } from '../src/indexer.js';
import { config, type Config } from '../src/config.js';
import { createApp } from '../src/app.js';
import { issueToken, passwordHash } from '../src/auth.js';
import { createOAuth } from '../src/oauth.js';
import { collectionName, type Embedder } from '../src/embedding.js';
import { organize } from '../src/organize.js';
import { scopeSchema } from '../src/scope.js';
const globalScope = scopeSchema.parse({ namespaces: ['global'] });

const connection = process.env.DATABASE_URL;
if (!connection || new URL(connection).pathname !== '/uni_memory_test') throw new Error('集成测试仅允许专用 uni_memory_test 数据库');
const pool = createPool(connection);
const store = new Store(pool);
let qdrant: Qdrant; let cfg: Config; let server: Server; let base: string;
let writer: string; let reader: string; let admin: string;
const fact = (key: string = randomUUID(), content = '合成事实：测试用户偏好中文。') => ({ namespace: 'global', type: 'fact' as const, verification: 'confirmed' as const, key, content, source: { reference: 'synthetic:test' }, idempotency_key: randomUUID() });
async function request(path: string, token = reader, body?: unknown, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
before(async () => {
  await migrate(pool, await readMigrations(new URL('../../migrations/', import.meta.url)));
  await pool.query('TRUNCATE memories,memory_sources,memory_events,idempotency,index_jobs,index_entries,index_generations,client_tokens,oauth_state RESTART IDENTITY');
  server = createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
  cfg = config({ ...process.env, PUBLIC_URL: base });
  qdrant = new Qdrant(cfg);
  await qdrant.request('/collections');
  writer = (await issueToken(pool, 'codex-test', ['memory:read', 'memory:write'])).token;
  reader = (await issueToken(pool, 'codebuddy-test', ['memory:read'])).token;
  admin = (await issueToken(pool, 'admin-test', ['memory:admin'])).token;
  server.on('request', createApp({ cfg, store, qdrant, search: new Search(store, qdrant) }));
});
after(async () => {
  if (server) await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  await pool.end();
});

test('真实数据库迁移可重复执行，健康检查区分依赖', async () => {
  assert.deepEqual(await migrate(pool, await readMigrations(new URL('../../migrations/', import.meta.url))), []);
  const health = await fetch(`${base}/healthz`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: 'ok' });
  assert.equal(health.headers.get('x-powered-by'), null);
  assert.equal((await fetch(`${base}/memories`)).status, 404);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
});

test('启动阶段 OAuth 配置失败时关闭已创建的推理线程并退出', () => {
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('../src/main.js', import.meta.url))], {
    env: { ...process.env, DATABASE_URL: connection, PUBLIC_URL: 'http://127.0.0.1:3000',
      EMBEDDING_MODEL: 'gemma2', EMBEDDING_DTYPE: 'q4', OAUTH_ENABLED: 'true', OWNER_PASSWORD_HASH: '', OAUTH_COOKIE_KEY: '' },
    encoding: 'utf8', timeout: 15000,
  });
  assert.equal(child.error, undefined);
  assert.equal(child.status, 1);
  assert.match(child.stderr, /启动失败/);
});
test('跨客户端读取、来源身份、幂等、来源合并和显式纠正', async () => {
  const input = fact();
  const result = await request('/v1/memories', writer, input); assert.equal(result.status, 201);
  const created = await result.json(); const id = created.memory.id;
  assert.deepEqual(await (await request('/v1/memories', writer, input)).json(), created);
  assert.equal((await request('/v1/memories', writer, { ...input, content: '不同内容' })).status, 409);
  const read = await (await request(`/v1/memories?id=${id}`)).json();
  assert.equal(read.sources[0].client_id, 'codex-test');
  assert.equal((await request('/v1/memories', writer, { ...input, client_id: 'admin' })).status, 400);
  const other = fact(input.key, input.content);
  other.source.reference = 'synthetic:second';
  const merged = await (await request('/v1/memories', writer, other)).json();
  assert.equal(merged.status, 'merged');
  assert.equal(merged.memory.sources.length, 2);
  const correction = { ...fact(input.key, '合成事实：测试用户偏好中文和英文。'), expected_version: 1 };
  const updated = await (await request('/v1/memories', writer, correction)).json();
  assert.equal(updated.memory.version, 2);
  const conflict = await request('/v1/memories', writer, fact(input.key, '未明确纠正的相反事实'));
  assert.equal(conflict.status, 409);
  const history = await (await request(`/v1/memories/history?id=${id}`)).json();
  assert(history.some((event: any) => event.snapshot.content === input.content));
  assert.deepEqual(history.at(-1).snapshot.sources, updated.memory.sources);
  assert.deepEqual(history.at(-1).snapshot, await (await request(`/v1/memories?id=${id}`)).json());
});
test('并发纠正仅一个版本成功，重复创建不产生两个当前事实', async () => {
  const input = fact();
  const initial = await store.write('test', input); const memory = initial.memory as any;
  const results = await Promise.all(['新值 A', '新值 B'].map(content => store.write('test', { ...fact(input.key, content), expected_version: 1 })));
  assert.deepEqual(results.map(row => row.status).sort(), ['conflict', 'updated']);
  assert.equal((await store.get({ id: memory.id })).version, 2);
  const duplicate = fact();
  const merged = await Promise.all([store.write('a', duplicate), store.write('b', duplicate)]);
  assert.deepEqual(merged.map(row => row.status).sort(), ['created', 'merged']);
});

test('Unicode key 写入后可按原 key 读取、查历史及合并', async () => {
  const input = fact('ｓｅｒｖｅｒ.①');
  const response = await request('/v1/memories', writer, input);
  assert.equal(response.status, 201);
  const created = await response.json();
  assert.equal(created.memory.key, 'server.1');
  const selector = new URLSearchParams({ namespace: input.namespace, key: input.key });
  const read = await request(`/v1/memories?${selector}`);
  assert.equal(read.status, 200);
  assert.equal((await read.json()).id, created.memory.id);
  const history = await request(`/v1/memories/history?${selector}`);
  assert.equal(history.status, 200);
  assert.equal((await history.json())[0].snapshot.key, 'server.1');
  const merged = await request('/v1/memories', writer, { ...input, key: 'server.1', idempotency_key: randomUUID() });
  assert.equal((await merged.json()).status, 'merged');
});
test('过期事实不可查询；置顶、关键词检索与无模型降级', async () => {
  await store.write('test', { ...fact('test.expired', '永不过期暗号 Pineapple'), pinned: true, expires_at: '2020-01-01T00:00:00Z' });
  await assert.rejects(store.get({ namespace: 'global', key: 'test.expired' }));
  const current = await store.write('test', { ...fact('test.pinned', '当前有效暗号 Blueberry'), pinned: true });
  assert((await store.core(globalScope)).some(row => row.id === (current.memory as any).id));
  assert(!(await store.core(globalScope)).some(row => row.key === 'test.expired'));
  const found = await new Search(store, qdrant).search({ namespaces: ['global'], query: 'Blueberry' });
  assert.equal(found.degraded, true); assert.equal(found.memories[0]?.key, 'test.pinned');
  assert.equal((await new Search(store, qdrant).search({ namespaces: ['global'], query: 'Pineapple' })).memories.length, 0);
});

test('同 key 跨分区独立、显式范围和层级边界、类型与多标签过滤', async () => {
  const key = 'partition.shared';
  const entries = [
    { namespace: 'global', type: 'fact', tags: ['linux'], verification: 'confirmed' },
    { namespace: 'projects/homelab', type: 'decision', tags: ['unraid', 'linux'], verification: 'confirmed' },
    { namespace: 'projects/homelab/linux', type: 'status', tags: ['linux'], verification: 'pending' },
    { namespace: 'projects/homelab-other', type: 'fact', tags: ['linux'], verification: 'confirmed' },
  ];
  for (const entry of entries) await store.write('test', { ...fact(key, 'PartitionNeedle'), ...entry, pinned: true });
  const home = await store.get({ namespace: 'projects/homelab', key });
  assert.equal(home.type, 'decision');
  assert.notEqual(home.id, (await store.get({ namespace: 'global', key })).id);
  assert.equal((await request(`/v1/memories?key=${key}`)).status, 400);
  assert.equal((await request('/v1/memories/core', reader)).status, 400);
  const core = await (await request('/v1/memories/core?namespaces=global&namespaces=projects%2Fhomelab&include_descendants=false')).json();
  assert.deepEqual(core.filter((m: any) => m.key === key).map((m: any) => m.namespace).sort(), ['global', 'projects/homelab']);
  const search = new Search(store, qdrant);
  const exact = await search.search({ query: 'PartitionNeedle', namespaces: ['projects/homelab'] });
  assert.deepEqual(exact.memories.map(m => m.namespace), ['projects/homelab']);
  const subtree = await search.search({ query: 'PartitionNeedle', namespaces: ['projects/homelab'], include_descendants: true });
  assert.deepEqual(subtree.memories.map(m => m.namespace).sort(), ['projects/homelab', 'projects/homelab/linux']);
  const filtered = await search.search({ query: 'PartitionNeedle', namespaces: ['projects'], include_descendants: true,
    tags: ['linux', 'unraid'], type: 'decision', verification: 'confirmed' });
  assert.deepEqual(filtered.memories.map(m => m.id), [home.id]);
  const history = await store.history({ namespace: 'projects/homelab', key });
  assert.equal(history[0].snapshot.namespace, 'projects/homelab');
  assert.equal((await request('/v1/memories/core?namespaces=global&include_descendants=wrong')).status, 400);
});

test('待核实冲突保留双方内容、来源与历史，并按版本解决', async () => {
  const input = { ...fact('partition.conflict', '用户先前陈述：服务器运行 Linux。'), namespace: 'projects/homelab', type: 'fact' };
  const initial = await store.write('a', input);
  const updated = await store.write('b', { ...input, content: '待核实：用户先前陈述运行 Linux；本次引用资料称运行 BSD。',
    verification: 'pending', expected_version: 1, idempotency_key: randomUUID(), source: { reference: 'synthetic:conflicting-reference' } });
  const pending = updated.memory as any;
  assert.equal(pending.id, (initial.memory as any).id);
  assert.equal(pending.verification, 'pending'); assert.equal(pending.sources.length, 2);
  assert.equal(pending.version, 2);
  assert.equal((await store.history({ id: pending.id })).length, 2);
  const stale = await store.write('a', { ...input, expected_version: 1, idempotency_key: randomUUID() });
  assert.equal(stale.status, 'conflict');
  const resolved = await store.write('a', { ...input, expected_version: 2, idempotency_key: randomUUID() });
  assert.equal((resolved.memory as any).verification, 'confirmed');
});

test('原表升级保留正文、来源、版本和历史，旧索引重新登记', async () => {
  const schema = `migration_${randomUUID().replaceAll('-', '')}`;
  await pool.query(`CREATE SCHEMA ${schema}`);
  const url = new URL(connection!); url.searchParams.set('options', `-c search_path=${schema},public`);
  const isolated = createPool(url.toString());
  try {
    const files = await readMigrations(new URL('../../migrations/', import.meta.url));
    await migrate(isolated, files.slice(0, 1));
    const id = randomUUID();
    await isolated.query('INSERT INTO memories(id,key,content,version) VALUES($1,$2,$3,3)', [id, 'legacy.example', '合成旧事实']);
    await isolated.query('INSERT INTO memory_sources(memory_id,client_id,reference) VALUES($1,$2,$3)', [id, 'legacy', 'synthetic:legacy']);
    await isolated.query('INSERT INTO memory_events(memory_id,version,client_id,snapshot) VALUES($1,3,$2,$3)', [id, 'legacy', { content: '合成旧事实', version: 3 }]);
    await isolated.query("INSERT INTO index_generations(name,model,dtype,dimensions,active) VALUES('legacy','synthetic','test',3,true)");
    await isolated.query("INSERT INTO index_entries(generation,memory_id,version) VALUES('legacy',$1,3)", [id]);
    await migrate(isolated, files);
    const upgraded = await new Store(isolated).get({ id });
    assert.equal(upgraded.namespace, 'global'); assert.equal(upgraded.verification, 'pending');
    assert.equal(upgraded.version, 3); assert.equal(upgraded.content, '合成旧事实'); assert.equal(upgraded.sources.length, 1);
    assert.equal((await new Store(isolated).history({ id }))[0].snapshot.version, 3);
    assert.equal((await isolated.query('SELECT 1 FROM index_generations WHERE active')).rowCount, 0);
    assert.equal((await isolated.query('SELECT 1 FROM index_entries')).rowCount, 0);
    assert.equal((await isolated.query('SELECT memory_id FROM index_jobs')).rows[0].memory_id, id);
    assert.deepEqual(await migrate(isolated, files), []);
  } finally {
    await isolated.end(); await pool.query(`DROP SCHEMA ${schema} CASCADE`);
  }
});
test('权限、过期与撤销、来源校验、Host/Origin、大小及凭据拒绝', async () => {
  assert.equal((await fetch(`${base}/v1/memories/core?namespaces=global`)).status, 401);
  assert.equal((await request('/v1/memories', reader, fact())).status, 403);
  assert.equal((await request('/v1/tasks', reader)).status, 403);
  assert.equal((await request('/v1/tasks', admin)).status, 200);
  assert.equal((await request('/v1/memories/core', reader, undefined, { Origin: 'https://attacker.invalid' })).status, 403);
  const invalidHost = await new Promise<number | undefined>((resolve, reject) => {
    const req = httpRequest(`${base}/v1/memories/core?namespaces=global`, { headers: { Host: 'attacker.invalid', Authorization: `Bearer ${reader}` } }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject); req.end();
  });
  assert.equal(invalidHost, 403);
  assert.equal((await request('/v1/memories', writer, fact(randomUUID(), 'x'.repeat(40000)))).status, 413);
  assert.equal((await request('/v1/memories', writer, fact(randomUUID(), 'api_key=synthetic_credentials_for_rejection'))).status, 422);
  const expired = await issueToken(pool, 'expired', ['memory:read']);
  await pool.query("UPDATE client_tokens SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.id]);
  assert.equal((await request('/v1/memories/core', expired.token)).status, 401);
  const revoked = await issueToken(pool, 'revoked', ['memory:read']);
  await pool.query('UPDATE client_tokens SET revoked_at=now() WHERE id=$1', [revoked.id]);
  assert.equal((await request('/v1/memories/core', revoked.token)).status, 401);
});
test('SDK 客户端完成 MCP 握手、六个工具发现、读写及工具权限', async () => {
  for (const token of [writer, reader]) {
    const client = new Client({ name: 'synthetic-client', version: '1' });
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
      const list = await client.listTools(); assert.equal(list.tools.length, 6);
      assert(client.getInstructions()?.includes('Shared Memory Policy v1'));
      const writeTool = list.tools.find(t => t.name === 'memory_write')!;
      for (const field of ['namespace', 'type', 'verification']) assert(writeTool.inputSchema.required?.includes(field));
      const result = await client.callTool({ name: 'memory_write', arguments: fact() });
      assert.equal(!!result.isError, token === reader);
      const core = await client.callTool({ name: 'memory_core', arguments: { namespaces: ['global'] } }); assert(!core.isError);
    } finally { await client.close(); }
  }
});
const syntheticEmbedder = (model = 'synthetic-test-only'): Embedder => ({ model, dtype: 'test', dimensions: 3,
  embed: async texts => texts.map(() => [1, 0, 0]),
});
test('真实 Qdrant 索引、旧版本过滤、失败重试、重启恢复和模型集合切换', async () => {
  const embedder = syntheticEmbedder();
  const indexer = new Indexer(pool, qdrant, embedder);
  const input = fact('test.vector', 'vector 事实');
  const result = await store.write('test', input); const memory = result.memory as any;
  await indexer.rebuild();
  for (let i = 0; i < 60 && (await pool.query('SELECT 1 FROM index_jobs')).rowCount; i++) await indexer.tick();
  const generation = collectionName(embedder);
  assert.equal((await pool.query('SELECT name FROM index_generations WHERE active')).rows[0]?.name, generation);
  assert((await qdrant.search(generation, [1, 0, 0], 100, globalScope)).some(row => row.id === memory.id));
  await store.write('test', { ...fact(input.key, 'vector 更新'), expected_version: 1 });
  const search = await new Search(store, qdrant, embedder).search({ namespaces: ['global'], query: '不存在的词语' });
  assert(!search.memories.some(row => row.id === memory.id));
  const broken = new Qdrant({ qdrantUrl: 'http://127.0.0.1:1', qdrantKey: undefined });
  await assert.rejects(new Indexer(pool, broken, embedder).tick());
  assert.equal((await pool.query('SELECT attempts FROM index_jobs WHERE memory_id=$1', [memory.id])).rows[0]?.attempts, 1);
  const restarted = new Indexer(pool, qdrant, embedder);
  await pool.query("UPDATE index_jobs SET attempts=10,failed=true,error_code='index_failed',available_at=now()+interval '1 hour' WHERE memory_id=$1", [memory.id]);
  const retry = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'retry'], {
    env: { ...process.env, DATABASE_URL: connection }, encoding: 'utf8', timeout: 15000,
  });
  assert.equal(retry.error, undefined);
  assert.equal(retry.status, 0, retry.stderr);
  const job = (await pool.query('SELECT attempts,failed,error_code,available_at<=now() AS ready FROM index_jobs WHERE memory_id=$1', [memory.id])).rows[0];
  assert.deepEqual(job, { attempts: 0, failed: false, error_code: null, ready: true });
  await restarted.tick();
  const fresh = await qdrant.search(generation, [1, 0, 0], 100, globalScope);
  assert.equal(fresh.find(row => row.id === memory.id)?.payload.version, 2);
  const fallback = await new Search(store, broken, embedder).search({ namespaces: ['global'], query: 'vector' });
  assert.equal(fallback.degraded, true); assert(fallback.memories.some(row => row.id === memory.id));
  const next = syntheticEmbedder('synthetic-test-only-next');
  const switching = new Indexer(pool, qdrant, next);
  await switching.rebuild();
  await switching.tick();
  assert.equal((await pool.query('SELECT name FROM index_generations WHERE active')).rows[0]?.name, generation);
  for (let i = 0; i < 60 && (await pool.query('SELECT 1 FROM index_jobs')).rowCount; i++) await switching.tick();
  assert.equal((await pool.query('SELECT name FROM index_generations WHERE active')).rows[0]?.name, collectionName(next));
});
test('新集合登记任务失败时整体回滚，下一轮仍会登记全部事实', async () => {
  const embedder = syntheticEmbedder('synthetic-test-only-registration');
  const name = collectionName(embedder);
  const limited = createPool(connection);
  const setup = await limited.connect();
  await setup.query('SET statement_timeout=200'); setup.release();
  const blocker = await pool.connect();
  try {
    await qdrant.ensure(name, embedder.dimensions);
    await blocker.query('BEGIN');
    await blocker.query('LOCK TABLE index_jobs IN ACCESS EXCLUSIVE MODE');
    await assert.rejects(new Indexer(limited, qdrant, embedder).tick());
    await blocker.query('ROLLBACK');
    assert.equal((await pool.query('SELECT 1 FROM index_generations WHERE name=$1', [name])).rowCount, 0);
    const indexer = new Indexer(pool, qdrant, embedder);
    await indexer.tick();
    const missing = await pool.query(`SELECT m.id FROM memories m
      LEFT JOIN index_entries e ON e.memory_id=m.id AND e.generation=$1
      LEFT JOIN index_jobs j ON j.memory_id=m.id
      WHERE m.deleted_at IS NULL AND e.memory_id IS NULL AND j.memory_id IS NULL`, [name]);
    assert.equal(missing.rowCount, 0);
  } finally {
    await blocker.query('ROLLBACK'); blocker.release();
    await limited.end();
    await qdrant.request(`/collections/${name}`, 'DELETE');
    await pool.query('DELETE FROM index_generations WHERE name=$1', [name]);
  }
});

test('推理过程中发生删除不会把旧向量写回索引', async () => {
  const input = fact('test.delete-during-index', '索引过程中的合成事实');
  const result = await store.write('test', input); const memory = result.memory as any;
  let first = true;
  const embedder = syntheticEmbedder('synthetic-test-only-next');
  embedder.embed = async texts => {
    if (first) { first = false; await store.delete('racer', { id: memory.id, expected_version: 1, idempotency_key: randomUUID() }); }
    return texts.map(() => [1, 0, 0]);
  };
  const indexer = new Indexer(pool, qdrant, embedder);
  await indexer.tick();
  await indexer.tick();
  await assert.rejects(store.get({ id: memory.id }));
  assert(!(await qdrant.search(collectionName(embedder), [1, 0, 0], 100, globalScope)).some(hit => hit.id === memory.id));
});
test('删除即时清除数据库正文、历史、来源和幂等缓存，并传播所有集合', async () => {
  const input = fact('test.deleted', '删除后不得保留的合成正文');
  const result = await store.write('test', input); const memory = result.memory as any;
  const embedder = syntheticEmbedder('synthetic-test-only-next');
  const indexer = new Indexer(pool, qdrant, embedder);
  for (let i = 0; i < 20 && (await pool.query('SELECT 1 FROM index_jobs')).rowCount; i++) await indexer.tick();
  await store.delete('test', { id: memory.id, expected_version: 1, idempotency_key: randomUUID() });
  await assert.rejects(store.get({ id: memory.id }));
  await assert.rejects(store.history({ id: memory.id }));
  assert.equal((await pool.query('SELECT 1 FROM memory_sources WHERE memory_id=$1', [memory.id])).rowCount, 0);
  assert.equal((await pool.query('SELECT 1 FROM memory_events WHERE memory_id=$1', [memory.id])).rowCount, 0);
  const replay = await store.write('test', input); assert.equal(replay.status, 'deleted');
  assert(!(JSON.stringify((await pool.query('SELECT result FROM idempotency WHERE memory_id=$1', [memory.id])).rows)).includes(input.content));
  // 即使未配置模型，也必须消费索引删除任务。
  const deletions = new Indexer(pool, qdrant);
  await deletions.tick();
  for (const row of (await pool.query('SELECT name FROM index_generations')).rows) {
    assert(!(await qdrant.search(row.name, [1, 0, 0], 100, globalScope)).some(hit => hit.id === memory.id));
  }
});

test('向量在候选截断前过滤分区、子层级和全部标签，回查再次过滤', async () => {
  const embedder = syntheticEmbedder('synthetic-partition-filter');
  const name = collectionName(embedder);
  const previous = (await pool.query('SELECT name FROM index_generations WHERE active')).rows[0]?.name;
  const result = await store.write('test', { ...fact('partition.vector', '合成向量目标'), namespace: 'projects/vector-filter/home/linux',
    tags: ['linux', 'unraid'], type: 'decision', verification: 'pending' });
  const target = await store.get({ id: (result.memory as any).id });
  try {
    await qdrant.ensure(name, 3);
    await qdrant.upsert(name, target, [0.9, 0.1, 0]);
    const indexed = await qdrant.request(`/collections/${name}/points/${target.id}`);
    assert.deepEqual(indexed.payload.namespace_paths, ['projects', 'projects/vector-filter', 'projects/vector-filter/home', 'projects/vector-filter/home/linux']);
    await qdrant.request(`/collections/${name}/points?wait=true`, 'PUT', { points: Array.from({ length: 110 }, () => ({
      id: randomUUID(), vector: [1, 0, 0], payload: { version: 1, namespace: 'projects/vector-filter/home-other',
        namespace_paths: ['projects', 'projects/vector-filter', 'projects/vector-filter/home-other'], tags: ['linux', 'unraid'], type: 'decision', verification: 'pending' },
    })) });
    await pool.query('UPDATE index_generations SET active=false');
    await pool.query(`INSERT INTO index_generations(name,model,dtype,dimensions,active) VALUES($1,$2,$3,3,true)
      ON CONFLICT(name) DO UPDATE SET active=true`, [name, embedder.model, embedder.dtype]);
    const search = new Search(store, qdrant, embedder);
    const scope = { namespaces: ['projects/vector-filter/home'], include_descendants: true, tags: ['linux', 'unraid'], type: 'decision', verification: 'pending' };
    const hits = await search.search({ ...scope, query: 'nonlexical-needle-928104' });
    assert.equal(hits.degraded, false); assert.deepEqual(hits.memories.map(m => m.id), [target.id]);
    for (const override of [{ include_descendants: false }, { tags: ['linux', 'missing'] }, { type: 'fact' }, { verification: 'confirmed' }]) {
      assert.equal((await search.search({ ...scope, ...override, query: 'nonlexical-needle-928104' })).memories.length, 0);
    }
    // 模拟索引 payload 与当前数据库不一致；返回前必须再次检查范围。
    await pool.query("UPDATE memories SET namespace='projects/elsewhere' WHERE id=$1", [target.id]);
    assert.equal((await search.search({ ...scope, query: 'nonlexical-needle-928104' })).memories.length, 0);
  } finally {
    await pool.query('UPDATE index_generations SET active=false WHERE name=$1', [name]);
    if (previous) await pool.query('UPDATE index_generations SET active=true WHERE name=$1', [previous]);
    await qdrant.request(`/collections/${name}`, 'DELETE');
    await pool.query('DELETE FROM index_generations WHERE name=$1', [name]);
  }
});

test('整理 API 只发送所选当前事实，返回建议不写库，并处理错误/超时/非法响应', async () => {
  const input = fact('test.organize', '选中的合成事实');
  const result = await store.write('test', input); const memory = result.memory as any;
  let mode = 'valid'; let calls = 0;
  const mock = createServer(async (req, res) => {
    calls++; assert.equal(req.url, '/v1/chat/completions');
    let body = ''; for await (const part of req) body += part;
    const data = JSON.parse(body);
    assert.equal(data.stream, false); assert.equal(data.model, 'synthetic-model');
    assert(!body.includes('synthetic:test')); assert(!body.includes('未选择的合成事实'));
    const facts = JSON.parse(data.messages[1].content); assert.equal(facts.length, 1); assert.equal(facts[0].id, memory.id);
    if (mode === 'slow') { setTimeout(() => res.end('{}'), 100); return; }
    if (mode === 'error') { res.writeHead(500).end('{}'); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(mode === 'invalid' ? '{}' : JSON.stringify({ choices: [{ message: { content: JSON.stringify({ suggestions: [{ source_ids: [mode === 'unknown' ? randomUUID() : memory.id], content: '整理建议' }] }) } }] }));
  });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const addr = mock.address(); assert(addr && typeof addr !== 'string');
  const settings = { ...cfg, organizeEnabled: true, llmBase: `http://127.0.0.1:${addr.port}/v1`, llmKey: 'synthetic-test', llmModel: 'synthetic-model' };
  try {
    await store.write('test', fact('test.not-selected', '未选择的合成事实'));
    const suggestions = await organize(store, settings, [memory.id]); assert.equal(suggestions.applied, false);
    assert.equal((await store.get({ id: memory.id })).content, input.content);
    for (mode of ['error', 'invalid', 'unknown', 'slow']) await assert.rejects(organize(store, settings, [memory.id], mode === 'slow' ? 10 : 1000));
    const beforeDisabled = calls;
    await assert.rejects(organize(store, { ...settings, organizeEnabled: false }, [memory.id]));
    assert.equal(calls, beforeDisabled);
  } finally { await new Promise<void>(resolve => { mock.close(() => resolve()); mock.closeAllConnections(); }); }
});

test('OAuth 实际授权码/PKCE、登录 CSRF、资源和回调校验、刷新轮换与授权撤销', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uni-memory-oauth-'));
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwksPath = join(directory, 'jwks.json');
  await writeFile(jwksPath, JSON.stringify({ keys: [{ ...privateKey.export({ format: 'jwk' }), kid: 'test', alg: 'RS256', use: 'sig' }] }));
  const oauthServer = createServer(); oauthServer.listen(0, '127.0.0.1'); await once(oauthServer, 'listening');
  const address = oauthServer.address(); assert(address && typeof address !== 'string');
  const origin = `http://127.0.0.1:${address.port}`;
  const password = 'synthetic-test-password-long';
  const settings = { ...cfg, publicUrl: origin, resource: `${origin}/mcp`, allowedOrigins: [origin], ownerHash: passwordHash(password), cookieKey: randomBytes(32).toString('hex'), jwksPath,
    oauthClients: JSON.stringify([{ client_id: 'synthetic-chatgpt', redirect_uris: [`${origin}/callback`], token_endpoint_auth_method: 'none' }]) };
  const provider = await createOAuth(pool, settings);
  oauthServer.on('request', createApp({ cfg: settings, store, qdrant, provider, search: new Search(store, qdrant) }));
  const jar = new Map<string, string>();
  async function http(path: string, body?: URLSearchParams) {
    const response = await fetch(new URL(path, origin), { redirect: 'manual', method: body ? 'POST' : 'GET',
      headers: { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...(body ? { Origin: origin, 'Content-Type': 'application/x-www-form-urlencoded' } : {}) }, body });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';'); const index = pair!.indexOf('='); jar.set(pair!.slice(0, index), pair!.slice(index + 1));
    }
    return response;
  }
  async function authorize(verifier: string) {
    const params = new URLSearchParams({ client_id: 'synthetic-chatgpt', redirect_uri: `${origin}/callback`, response_type: 'code', scope: 'openid offline_access memory:read memory:write',
      code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', resource: settings.resource, state: 'synthetic-state', prompt: 'consent' });
    let response = await http(`/oauth/auth?${params}`);
    for (let i = 0; i < 12; i++) {
      const location = response.headers.get('location');
      if (location?.startsWith(`${origin}/callback`)) {
        const callback = new URL(location); assert.equal(callback.searchParams.get('state'), 'synthetic-state');
        assert(callback.searchParams.get('code'), await response.text()); return callback.searchParams.get('code')!;
      }
      assert(location, `OAuth missing redirect: ${response.status} ${await response.text()}`);
      response = await http(location);
      if (response.status === 200 && new URL(location, origin).pathname.startsWith('/interaction/')) {
        const html = await response.text();
        const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(html)?.[1]; assert(csrf);
        if (html.includes('name="password"')) {
          const rejected = await http(location, new URLSearchParams({ csrf: 'wrong', password })); assert.equal(rejected.status, 403);
        }
        response = await http(location, new URLSearchParams({ csrf, password }));
      }
    }
    throw new Error('OAuth redirect loop');
  }
  try {
    const metadata = await (await http('/oauth/.well-known/oauth-authorization-server')).json();
    assert(metadata.code_challenge_methods_supported.includes('S256'));
    const badCallback = await http(`/oauth/auth?${new URLSearchParams({ client_id: 'synthetic-chatgpt', redirect_uri: 'https://attacker.invalid', response_type: 'code', scope: 'openid' })}`);
    assert.equal(badCallback.status, 400);
    const badResource = await http(`/oauth/auth?${new URLSearchParams({ client_id: 'synthetic-chatgpt', redirect_uri: `${origin}/callback`, response_type: 'code', scope: 'openid', resource: 'https://attacker.invalid', code_challenge: 'a'.repeat(43), code_challenge_method: 'S256' })}`);
    const badLocation = badResource.headers.get('location');
    assert(badResource.status === 400 || badLocation?.includes('error='));
    const verifier = randomBytes(48).toString('base64url');
    const code = await authorize(verifier);
    const params = new URLSearchParams({ grant_type: 'authorization_code', client_id: 'synthetic-chatgpt', redirect_uri: `${origin}/callback`, code, code_verifier: verifier, resource: settings.resource });
    const tokenResponse = await http('/oauth/token', params);
    const tokens = await tokenResponse.json(); assert.equal(tokenResponse.status, 200, JSON.stringify(tokens));
    assert(tokens.refresh_token);
    const call = await fetch(`${origin}/v1/memories/core?namespaces=global`, { headers: { Authorization: `Bearer ${tokens.access_token}` } }); assert.equal(call.status, 200);
    const replay = await http('/oauth/token', params); assert.equal(replay.status, 400);
    const wrongVerifierCode = await authorize(verifier);
    const wrong = await http('/oauth/token', new URLSearchParams({ ...Object.fromEntries(params), code: wrongVerifierCode, code_verifier: randomBytes(48).toString('base64url') })); assert.equal(wrong.status, 400);
    const freshCode = await authorize(verifier);
    const fresh = await (await http('/oauth/token', new URLSearchParams({ ...Object.fromEntries(params), code: freshCode }))).json();
    const refreshed = await (await http('/oauth/token', new URLSearchParams({ grant_type: 'refresh_token', client_id: 'synthetic-chatgpt', refresh_token: fresh.refresh_token, resource: settings.resource }))).json();
    assert(refreshed.access_token); assert(refreshed.refresh_token); assert.notEqual(refreshed.refresh_token, fresh.refresh_token);
    const access = await provider.AccessToken.find(refreshed.access_token); assert(access?.grantId);
    await pool.query("DELETE FROM oauth_state WHERE grant_id=$1 OR (model='Grant' AND id=$1)", [access.grantId]);
    assert.equal((await fetch(`${origin}/v1/memories/core?namespaces=global`, { headers: { Authorization: `Bearer ${refreshed.access_token}` } })).status, 401);
  } finally {
    await new Promise<void>(resolve => { oauthServer.close(() => resolve()); oauthServer.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  }
});
