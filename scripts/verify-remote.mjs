// 显式指定部署地址和客户端令牌，只创建并清除本脚本的合成验收事实。
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const url = process.env.UNI_MEMORY_URL;
const token = process.env.UNI_MEMORY_TOKEN;
assert(url && token, '需要 UNI_MEMORY_URL 和 UNI_MEMORY_TOKEN');
const client = new Client({ name: 'uni-memory-deployment-check', version: '0.2.0' });
const memories = new Map();
const call = async (name, args) => {
  const result = await client.callTool({ name, arguments: args });
  assert(!result.isError, `${name} 返回错误`);
  return JSON.parse(result.content.find(item => item.type === 'text').text);
};
try {
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { Authorization: `Bearer ${token}`, Origin: 'https://untrusted.example' } })).status, 403);
  await client.connect(new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  assert.equal((await client.listTools()).tools.length, 6);
  assert(client.getInstructions()?.includes('Shared Memory Policy v1'));
  const key = `synthetic.deployment.${randomUUID()}`;
  const parent = `projects/synthetic-check/${randomUUID()}`;
  const input = { namespace: `${parent}/linux`, type: 'fact', verification: 'confirmed', key, pinned: true, tags: ['linux', 'unraid'],
    content: '部署验收合成事实：琥珀色测试小车存放在蓝色书房。', source: { reference: 'synthetic:deployment-check' }, idempotency_key: randomUUID() };
  const written = await call('memory_write', input);
  let memory = written.memory; memories.set(memory.id, memory);
  const sibling = await call('memory_write', { ...input, namespace: `${parent}-other`, idempotency_key: randomUUID() });
  memories.set(sibling.memory.id, sibling.memory);
  assert.notEqual(memory.id, sibling.memory.id);
  assert.equal((await call('memory_get', { id: memory.id })).key, key);
  assert.equal((await call('memory_get', { namespace: input.namespace, key })).id, memory.id);
  assert((await client.callTool({ name: 'memory_search', arguments: { query: '测试' } })).isError);
  assert.equal((await call('memory_core', { namespaces: [parent] })).length, 0);
  assert.deepEqual((await call('memory_core', { namespaces: [parent], include_descendants: true })).map(m => m.id), [memory.id]);
  let found;
  for (let attempt = 0; attempt < 90; attempt++) {
    found = await call('memory_search', { namespaces: [parent], include_descendants: true, tags: ['linux', 'unraid'],
      type: 'fact', verification: 'confirmed', query: 'Where is the amber toy car stored?', limit: 10 });
    if (!found.degraded && found.memories.some(item => item.id === memory.id)) break;
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  assert.equal(found.degraded, false);
  assert.deepEqual(found.memories.map(item => item.id), [memory.id]);
  const updated = await call('memory_write', { ...input, content: `${input.content} 待核实的另一说法：存放在绿色客厅。`,
    verification: 'pending', expected_version: memory.version, source: { reference: 'synthetic:conflicting-report' }, idempotency_key: randomUUID() });
  memory = updated.memory; memories.set(memory.id, memory);
  assert.equal(memory.version, 2); assert.equal(memory.verification, 'pending'); assert.equal(memory.sources.length, 2);
  const history = await call('memory_history', { id: memory.id }); assert.equal(history.length, 2);
  console.log('部署验收通过：认证/Origin、MCP 默认策略及新字段、跨分区同 key、层级边界、标签/类型/核实过滤、Gemma 2 跨语言检索、待核实冲突与历史。');
} finally {
  const cleanup = await Promise.allSettled([...memories.values()].map(memory => call('memory_delete', { id: memory.id, expected_version: memory.version, idempotency_key: randomUUID() })));
  await client.close();
  for (const result of cleanup) if (result.status === 'rejected') throw result.reason;
}
