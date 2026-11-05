import assert from 'node:assert/strict';
import test from 'node:test';
import { passwordHash, passwordMatches, derivePassword, requireScope } from '../src/auth.js';
import { rejectSecrets, writeSchema } from '../src/validation.js';
import { config } from '../src/config.js';
import { fuse } from '../src/search.js';
import express from 'express';
import { createApp, rateLimit } from '../src/app.js';
import { once } from 'node:events';
import type { Pool } from 'pg';
import { createOAuth } from '../src/oauth.js';
import type Provider from 'oidc-provider';
import { errors } from 'oidc-provider';
import { organize } from '../src/organize.js';
import type { Store } from '../src/store.js';

test('scrypt、权限与公网 URL 校验', async () => {
  const password = 'a-synthetic-long-passphrase';
  const hash = passwordHash(password);
  assert(await passwordMatches(password, hash));
  assert(!await passwordMatches('wrong', hash));
  assert(!await passwordMatches(password, 'invalid'));
  assert.throws(() => requireScope({ clientId: 'r', scopes: ['memory:read'] }, 'memory:write'));
  assert.doesNotThrow(() => requireScope({ clientId: 'a', scopes: ['memory:admin'] }, 'memory:write'));
  assert.throws(() => config({ PUBLIC_URL: 'http://public.example' }));
  assert.throws(() => config({ PUBLIC_URL: 'https://public.example/path' }));
  const lanHost = [10, 0, 0, 1].join('.');
  const lanUrl = `http://${lanHost}:3100`;
  assert.throws(() => config({ PUBLIC_URL: lanUrl }));
  assert.doesNotThrow(() => config({ PUBLIC_URL: lanUrl, ALLOW_INSECURE_LAN_HTTP: 'true', OAUTH_ENABLED: 'false' }));
  assert.throws(() => config({ PUBLIC_URL: lanUrl, ALLOW_INSECURE_LAN_HTTP: 'true', OAUTH_ENABLED: 'true' }));
  assert.throws(() => config({ PUBLIC_URL: 'http://203.0.113.1:3100', ALLOW_INSECURE_LAN_HTTP: 'true' }));
  assert.throws(() => config({ PUBLIC_URL: 'http://lan-host:3100', ALLOW_INSECURE_LAN_HTTP: 'true' }));
  const https = config({ PUBLIC_URL: 'https://memory.example.com', OAUTH_ENABLED: 'true', ALLOWED_HOSTS: lanHost });
  assert(https.allowedHosts.includes('memory.example.com'));
  assert(https.allowedHosts.includes(lanHost));
  assert(!config({ PUBLIC_URL: 'https://memory.example.com' }).allowedHosts.includes(lanHost));
  for (const host of ['*', '*.example.com', 'example.com:3100', 'https://example.com', 'example.com/path']) {
    assert.throws(() => config({ ALLOWED_HOSTS: host }));
  }
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

test('OAuth 表单保留同源 Origin，继续拒绝空来源、跨源和错误 CSRF', async () => {
  const password = 'synthetic-form-login-password';
  const cfg = config({ OWNER_PASSWORD_HASH: passwordHash(password) });
  let completed = false;
  const provider = {
    interactionDetails: async () => {
      if (completed) throw new errors.SessionNotFound('interaction session not found');
      return { uid: 'synthetic', prompt: { name: 'login' }, params: { client_id: 'synthetic', scope: 'memory:read' } };
    },
    interactionFinished: async (_req: express.Request, res: express.Response) => { completed = true; res.status(204).end(); },
    callback: () => (req: express.Request, res: express.Response) => {
      if (req.url === '/.well-known/oauth-authorization-server') res.json({ issuer: `${cfg.publicUrl}/oauth` });
      else res.status(404).end();
    },
  } as unknown as Provider;
  const app = createApp({ cfg, provider, store: { pool: {} }, search: {}, qdrant: {} } as unknown as Parameters<typeof createApp>[0]);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}/interaction/synthetic`;
    const metadata = await fetch(`http://127.0.0.1:${address.port}/.well-known/oauth-authorization-server/oauth`, { redirect: 'manual' });
    assert.equal(metadata.status, 200);
    assert.deepEqual(await metadata.json(), { issuer: `${cfg.publicUrl}/oauth` });
    const page = await fetch(url);
    assert.equal(page.headers.get('referrer-policy'), 'same-origin');
    const cookie = page.headers.getSetCookie()[0]!.split(';')[0]!;
    const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(await page.text())![1]!;
    const submit = (origin: string, value = csrf) => fetch(url, { method: 'POST',
      headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams({ csrf: value, password }) });
    for (const origin of ['null', 'https://attacker.invalid']) assert.equal((await submit(origin)).status, 403);
    assert.equal((await submit(cfg.publicUrl, 'wrong')).status, 403);
    assert.equal((await submit(cfg.publicUrl)).status, 204);
    const repeated = await submit(cfg.publicUrl);
    assert.equal(repeated.status, 400);
    assert.deepEqual(await repeated.json(), { error: 'interaction_expired' });
    assert.equal((await fetch(url)).status, 400);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
});
test('写入输入严格、凭据拒绝与 RRF 去重', () => {
  assert.throws(() => writeSchema.parse({ key: 'x', content: 'x', client_id: 'fake' }));
  assert.throws(() => rejectSecrets({ content: 'api_key=synthetic-credentials' }));
  assert.doesNotThrow(() => rejectSecrets({ content: '用户希望密钥只放环境变量。' }));
  assert.deepEqual(fuse([['a', 'b', 'a'], ['b', 'c']], 3), ['b', 'a', 'c']);
});

test('本机地址例外仅允许 HTTP，不接受其他协议', async () => {
  const id = '319ea735-b71b-442f-92f4-c1e1b35ad09f';
  const store = { get: async () => ({ id, version: 1, key: 'synthetic', content: '合成事实' }) } as unknown as Store;
  for (const protocol of ['ftp:', 'file:', 'ws:']) {
    const url = `${protocol}//localhost/callback`;
    await assert.rejects(createOAuth({} as Pool, config({
      OWNER_PASSWORD_HASH: 'synthetic', OAUTH_COOKIE_KEY: 'x'.repeat(32),
      OAUTH_CLIENTS_JSON: JSON.stringify([{ client_id: 'synthetic', redirect_uris: [url] }]),
    })), /回调地址必须使用 HTTPS 或本机 HTTP/);
    await assert.rejects(organize(store, config({
      EXTERNAL_ORGANIZE_ENABLED: 'true', LLM_MODEL: 'synthetic', LLM_API_KEY: 'synthetic', LLM_BASE_URL: url,
    }), [id]), { message: 'unsafe_llm_url' });
  }
});

test('密码校验并发有界，繁忙时不堆积任务，完成后释放容量', async () => {
  const first = derivePassword('synthetic-password', 'synthetic-salt');
  const second = derivePassword('synthetic-password', 'synthetic-salt');
  await assert.rejects(derivePassword('synthetic-password', 'synthetic-salt'), { status: 503, code: 'password_check_busy' });
  const [a, b] = await Promise.all([first, second]);
  assert.deepEqual(a, b);
  assert.deepEqual(await derivePassword('synthetic-password', 'synthetic-salt'), a);
});

test('代理 Host 不影响应用；非可信来源不能伪造 OAuth HTTPS', async () => {
  for (const trusted of [false, true]) {
    const cfg = config({ PUBLIC_URL: 'https://memory.example.test', TRUST_PROXY: trusted ? 'loopback' : '' });
    const provider = { callback: () => (req: express.Request, res: express.Response) => {
      res.json({ protocol: req.headers['x-forwarded-proto'], forwardedHost: req.headers['x-forwarded-host'] ?? null });
    } } as unknown as Provider;
    const app = createApp({ cfg, provider, store: { pool: {} }, search: {}, qdrant: {} } as unknown as Parameters<typeof createApp>[0]);
    const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
    try {
      const address = server.address(); assert(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const response = await fetch(`${base}/oauth/synthetic`, { headers: { 'X-Forwarded-Proto': 'https', 'X-Forwarded-Host': 'attacker.invalid' } });
      assert.equal(response.status, trusted ? 200 : 403);
      if (trusted) assert.deepEqual(await response.json(), { protocol: 'https', forwardedHost: null });
      else assert.deepEqual(await response.json(), { error: 'https_required' });
      assert.equal((await fetch(`${base}/interaction/synthetic`, { method: 'POST' })).status, 403);
    } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
  }
});
