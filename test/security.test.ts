import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordHash, passwordMatches, requireScope } from '../src/auth.js';
import { rejectSecrets, writeSchema } from '../src/validation.js';
import { config } from '../src/config.js';
import { fuse } from '../src/search.js';
import express from 'express';
import { rateLimit } from '../src/app.js';
import { once } from 'node:events';

test('scrypt、权限与公网 URL 校验', () => {
  const password = 'a-synthetic-long-passphrase';
  const hash = passwordHash(password);
  assert(passwordMatches(password, hash));
  assert(!passwordMatches('wrong', hash));
  assert(!passwordMatches(password, 'invalid'));
  assert.throws(() => requireScope({ clientId: 'r', scopes: ['memory:read'] }, 'memory:write'));
  assert.doesNotThrow(() => requireScope({ clientId: 'a', scopes: ['memory:admin'] }, 'memory:write'));
  assert.throws(() => config({ PUBLIC_URL: 'http://public.example' }));
  assert.throws(() => config({ PUBLIC_URL: 'https://public.example/path' }));
  assert.throws(() => config({ PUBLIC_URL: 'http://192.168.1.200:3100' }));
  assert.doesNotThrow(() => config({ PUBLIC_URL: 'http://192.168.1.200:3100', ALLOW_INSECURE_LAN_HTTP: 'true', OAUTH_ENABLED: 'false' }));
  assert.throws(() => config({ PUBLIC_URL: 'http://192.168.1.200:3100', ALLOW_INSECURE_LAN_HTTP: 'true', OAUTH_ENABLED: 'true' }));
  assert.throws(() => config({ PUBLIC_URL: 'http://8.8.8.8:3100', ALLOW_INSECURE_LAN_HTTP: 'true' }));
  assert.throws(() => config({ PUBLIC_URL: 'http://tower:3100', ALLOW_INSECURE_LAN_HTTP: 'true' }));
});
test('请求频率超限返回 429 和 Retry-After', async () => {
  const app = express(); app.use(rateLimit(2)); app.get('/', (_req, res) => { res.end('ok'); });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/`;
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await fetch(url)).status, 200);
    const rejected = await fetch(url); assert.equal(rejected.status, 429); assert(rejected.headers.get('Retry-After'));
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
test('写入输入严格、凭据拒绝与 RRF 去重', () => {
  assert.throws(() => writeSchema.parse({ key: 'x', content: 'x', client_id: 'fake' }));
  assert.throws(() => rejectSecrets({ content: 'api_key=synthetic-credentials' }));
  assert.doesNotThrow(() => rejectSecrets({ content: '用户希望密钥只放环境变量。' }));
  assert.deepEqual(fuse([['a', 'b', 'a'], ['b', 'c']], 3), ['b', 'a', 'c']);
});
