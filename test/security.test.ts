import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { requireScope } from '../src/auth.js';
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

test('权限与公网 URL 校验', () => {
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

test('OAuth 表单校验部署令牌、同源 Origin 和 CSRF', async () => {
  const deploymentToken = 'synthetic-oauth-deployment-token-only';
  const cfg = config({ DEPLOYMENT_TOKEN: deploymentToken });
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
    const html = await page.text();
    const csrf = /name="csrf" value="([a-f0-9]+)"/.exec(html)![1]!;
    assert(html.includes('name="deployment_token"') && !html.includes(deploymentToken));
    const submit = (origin: string, value = csrf, token = deploymentToken) => fetch(url, { method: 'POST',
      headers: { Origin: origin, Cookie: cookie }, body: new URLSearchParams({ csrf: value, deployment_token: token }) });
    for (const origin of ['null', 'https://attacker.invalid']) assert.equal((await submit(origin)).status, 403);
    assert.equal((await submit(cfg.publicUrl, 'wrong')).status, 403);
    assert.equal((await submit(cfg.publicUrl, csrf, 'x'.repeat(32))).status, 401);
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
  assert.throws(() => rejectSecrets({ content: 'DEPLOYMENT_TOKEN=synthetic-credentials' }));
  assert.doesNotThrow(() => rejectSecrets({ content: '用户希望密钥只放环境变量。' }));
  assert.deepEqual(fuse([['a', 'b', 'a'], ['b', 'c']], 3), ['b', 'a', 'c']);
});

test('本机地址例外仅允许 HTTP，不接受其他协议', async () => {
  const id = '319ea735-b71b-442f-92f4-c1e1b35ad09f';
  const store = { get: async () => ({ id, version: 1, key: 'synthetic', content: '合成事实' }) } as unknown as Store;
  for (const protocol of ['ftp:', 'file:', 'ws:']) {
    const url = `${protocol}//localhost/callback`;
    await assert.rejects(createOAuth({} as Pool, config({
      DEPLOYMENT_TOKEN: 'x'.repeat(32), OAUTH_COOKIE_KEY: 'y'.repeat(32),
      OAUTH_CLIENTS_JSON: JSON.stringify([{ client_id: 'synthetic', redirect_uris: [url] }]),
    })), /回调地址必须使用 HTTPS 或本机 HTTP/);
    await assert.rejects(organize(store, config({
      EXTERNAL_ORGANIZE_ENABLED: 'true', LLM_MODEL: 'synthetic', LLM_API_KEY: 'synthetic', LLM_BASE_URL: url,
    }), [id]), { message: 'unsafe_llm_url' });
  }
});

test('OAuth 要求在部署环境配置有效令牌', async () => {
  for (const value of [undefined, 'short', '片段'.repeat(32)]) {
    await assert.rejects(createOAuth({} as Pool, config({
      DEPLOYMENT_TOKEN: value, OAUTH_COOKIE_KEY: 'y'.repeat(32),
    })), /DEPLOYMENT_TOKEN/);
  }
});

test('管理台入口已移除，独立 Bearer 仍可访问且权限不足触发质询', async () => {
  const deploymentToken = 'synthetic-deployment-token-for-authorization';
  const reader = 'synthetic-static-bearer-read-client';
  const writer = 'synthetic-static-bearer-write-client';
  const makeRecord = (token: string, client_id: string, scopes: string[]) => [
    createHash('sha256').update(token).digest('hex'), { id: client_id, client_id, scopes, active: true },
  ] as const;
  const records = new Map([
    makeRecord(reader, 'synthetic-reader', ['memory:read']),
    makeRecord(writer, 'synthetic-writer', ['memory:read', 'memory:write']),
  ]);
  const actors: string[] = [];
  const app = createApp({
    cfg: config({ DEPLOYMENT_TOKEN: deploymentToken }),
    store: {
      pool: { query: async (sql: string, args: string[]) => ({
        rows: sql.includes('FROM client_tokens') ? [records.get(args[0]!)] : [],
      }) },
      write: async (clientId: string) => { actors.push(clientId); return { status: 'created' }; },
    },
    provider: {
      callback: () => (_req: express.Request, res: express.Response) => res.status(404).end(),
      AccessToken: { find: async () => undefined },
    },
    search: {}, qdrant: {},
  } as unknown as Parameters<typeof createApp>[0]);
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const address = server.address(); assert(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(base)).status, 404);
    assert.equal((await fetch(`${base}/ui/login`, { method: 'POST' })).status, 404);
    assert.equal((await fetch(`${base}/v1/tasks`, { headers: { Cookie: 'uni_memory_admin=synthetic' } })).status, 401);
    const input = { namespace: 'global', key: 'synthetic.auth', type: 'fact', content: '合成事实', source: { reference: 'synthetic:test' }, idempotency_key: 'synthetic-auth-test' };
    const mcp = (token: string) => fetch(`${base}/mcp`, {
      method: 'POST', headers: {
        Authorization: `bearer ${token}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28', 'Mcp-Method': 'tools/call', 'Mcp-Name': 'memory_write',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call',
        params: { name: 'memory_write', arguments: input, _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {},
        } },
      }),
    });
    const invalid = await mcp(deploymentToken);
    assert.equal(invalid.status, 401);
    assert.match(invalid.headers.get('www-authenticate') ?? '', /error="invalid_token".*resource_metadata="/);
    const denied = await mcp(reader);
    assert.equal(denied.status, 403);
    const challenge = denied.headers.get('www-authenticate') ?? '';
    assert.match(challenge, /error="insufficient_scope"/);
    assert.match(challenge, /scope="memory:write"/);
    assert.match(challenge, /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/);
    const allowed = await mcp(writer);
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).result.isError, undefined);
    assert.deepEqual(actors, ['synthetic-writer']);
  } finally { await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); }
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
