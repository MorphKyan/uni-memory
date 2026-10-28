import assert from 'node:assert/strict';
import test from 'node:test';
import { memorySelector, searchSchema, writeSchema, namespacesSchema, listSchema, decodeListCursor } from '../src/validation.js';
import { namespaceSchema } from '../src/scope.js';

test('发现分区与列表严格校验范围、页大小和游标', () => {
  assert.deepEqual(namespacesSchema.parse({}), {});
  assert.deepEqual(namespacesSchema.parse({ parent: 'projects/home' }), { parent: 'projects/home' });
  for (const input of [{ parent: 'projects/' }, { namespaces: ['global'] }]) assert.throws(() => namespacesSchema.parse(input));
  assert.equal(listSchema.parse({ namespaces: ['global'] }).limit, 50);
  for (const input of [{}, { namespaces: [] }, { namespaces: ['global'], limit: 101 },
    { namespaces: ['global'], limit: 0 }, { namespaces: ['global'], query: 'x' },
    { namespaces: ['global'], cursor: '' }, { namespaces: ['global'], include_descendants: 'false' }]) {
    assert.throws(() => listSchema.parse(input));
  }
  const cursor = { created_at: '2026-10-28T00:00:00.123456Z', id: '319ea735-b71b-442f-92f4-c1e1b35ad09f' };
  assert.deepEqual(decodeListCursor(Buffer.from(JSON.stringify(cursor)).toString('base64url')), cursor);
  for (const value of ['not-json', '{}', JSON.stringify({ ...cursor, created_at: 'yesterday' }), JSON.stringify({ ...cursor, id: 'bad' })]) {
    assert.throws(() => decodeListCursor(Buffer.from(value).toString('base64url')), { code: 'invalid_cursor' });
  }
});

test('分区总览 key 规范化并要求长期有效，普通事实支持有效期', () => {
  const input = { namespace: 'projects/homelab', key: 'ｏｖｅｒｖｉｅｗ', type: 'status', verification: 'confirmed',
    content: '用途：家庭服务。现状：运行中。入口：server.os。', source: { reference: 'synthetic:overview' }, idempotency_key: 'overview' };
  const overview = writeSchema.parse({ ...input, pinned: false });
  assert.equal(overview.key, 'overview');
  assert.equal(overview.expires_at, null);
  assert.throws(() => writeSchema.parse({ ...input, expires_at: '2030-01-01T00:00:00Z' }));
  assert.equal(writeSchema.parse({ ...input, key: 'server.os' }).pinned, false);
  assert.equal(writeSchema.parse({ ...input, key: 'server.os', expires_at: '2030-01-01T00:00:00Z' }).expires_at, '2030-01-01T00:00:00Z');
});

test('分区字段必须显式提供，拒绝含糊选择器和非法层级', () => {
  const input = { namespace: 'projects/homelab', key: 'server.os', type: 'decision', verification: 'confirmed',
    content: '采用 Unraid', source: { reference: 'synthetic:partition' }, idempotency_key: 'operation' };
  assert.equal(writeSchema.parse(input).namespace, 'projects/homelab');
  for (const field of ['namespace', 'type', 'verification']) {
    const missing: Record<string, unknown> = { ...input }; delete missing[field];
    assert.throws(() => writeSchema.parse(missing));
  }
  for (const namespace of ['', '/projects', 'projects/', 'projects//home', 'projects/../home', 'Projects/Home', 'projects/home%', 'projects/ home']) {
    assert.throws(() => namespaceSchema.parse(namespace));
  }
  assert.throws(() => searchSchema.parse({ query: 'server' }));
  assert.throws(() => searchSchema.parse({ query: 'server', namespaces: [] }));
  assert.throws(() => memorySelector.parse({ key: 'server.os' }));
  assert.throws(() => memorySelector.parse({ id: '319ea735-b71b-442f-92f4-c1e1b35ad09f', namespace: 'global' }));
  assert.deepEqual(memorySelector.parse({ namespace: 'projects/homelab', key: 'server.os' }), { namespace: 'projects/homelab', key: 'server.os' });
});

test('key 在写入和选择器中采用相同规范化，并校验规范化后的长度', () => {
  const input = { namespace: 'global', key: 'ｓｅｒｖｅｒ.①', type: 'fact', verification: 'confirmed',
    content: '合成事实', source: { reference: 'synthetic:unicode' }, idempotency_key: 'operation' };
  assert.equal(writeSchema.parse(input).key, 'server.1');
  assert.equal(memorySelector.parse({ namespace: input.namespace, key: input.key }).key, 'server.1');
  assert.throws(() => writeSchema.parse({ ...input, key: 'ﬃ'.repeat(60) }));
  assert.throws(() => memorySelector.parse({ namespace: input.namespace, key: 'ﬃ'.repeat(60) }));
});
