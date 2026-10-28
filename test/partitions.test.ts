import assert from 'node:assert/strict';
import test from 'node:test';
import { memorySelector, searchSchema, writeSchema } from '../src/validation.js';
import { namespaceSchema } from '../src/scope.js';

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
