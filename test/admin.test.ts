import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import type { Store } from '../src/store.js';
import type { Search } from '../src/search.js';
import type { Qdrant } from '../src/qdrant.js';

const password = 'synthetic-admin-login-passphrase';
async function fixture(adminPassword: string | undefined = password, secure = false) {
  const cfg = config({ ADMIN_PASSWORD: adminPassword, ...(secure ? { PUBLIC_URL: 'https://memory.example.test', TRUST_PROXY: 'loopback' } : {}) });
  const writes: { actor: string; body: unknown }[] = [];
  const store = {
    pool: { query: async () => ({ rows: [] }) },
    namespaces: async () => ({ namespaces: [{ namespace: 'global', count: 1 }] }),
    list: async () => ({ memories: [], next_cursor: null }),
    write: async (actor: string, body: unknown) => { writes.push({ actor, body }); return { status: 'created' }; },
  } as unknown as Store;
  const app = createApp({ cfg, store, search: {} as Search, qdrant: {} as Qdrant });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); assert(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Uni-Memory-UI': '1', Origin: cfg.publicUrl, ...(secure ? { 'X-Forwarded-Proto': 'https' } : {}), ...headers }, body: JSON.stringify(body) });
  const close = () => new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); });
  return { base, post, close, writes };
}

test('管理台密码会话：CSRF、权限边界、轮换、退出与静态资源', async () => {
  const f = await fixture();
  try {
    const initial = await fetch(`${f.base}/ui/session`); assert.deepEqual(await initial.json(), { enabled: true, authenticated: false });
    assert.equal((await fetch(`${f.base}/v1/namespaces`)).status, 401);
    assert.equal((await f.post('/ui/login', { password }, { 'X-Uni-Memory-UI': '' })).status, 403);
    assert.equal((await f.post('/ui/login', { password }, { Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await f.post('/ui/login', { password: 'wrong' })).status, 401);
    const login = await f.post('/ui/login', { password }); assert.equal(login.status, 200);
    const setCookie = login.headers.getSetCookie()[0]!;
    assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /SameSite=Strict/); assert.match(setCookie, /Max-Age=43200/); assert(!setCookie.includes('Secure'));
    assert(!setCookie.includes(password));
    const cookie = setCookie.split(';')[0]!;
    const { csrf } = await login.json() as { csrf: string }; assert.equal(csrf.length, 43);
    const headers = { Cookie: cookie, 'X-CSRF-Token': csrf };
    const read = await fetch(`${f.base}/v1/namespaces`, { headers }); assert.equal(read.status, 200);
    const session = await fetch(`${f.base}/ui/session`, { headers }); assert.deepEqual(await session.json(), { enabled: true, authenticated: true, csrf });
    assert.equal((await f.post('/v1/memories/list', { namespaces: ['global'] }, { Cookie: cookie })).status, 403);
    assert.equal((await f.post('/v1/memories/list', { namespaces: ['global'] }, headers)).status, 200);
    assert.equal((await f.post('/v1/memories', { synthetic: true }, headers)).status, 201);
    assert.deepEqual(f.writes, [{ actor: 'web-admin', body: { synthetic: true } }]);
    assert.equal((await f.post('/mcp', { method: 'tools/list' }, headers)).status, 401);
    assert.equal((await fetch(`${f.base}/v1/namespaces`, { headers: { ...headers, Authorization: 'Bearer invalid-but-long-synthetic-token' } })).status, 401);
    assert.equal((await f.post('/ui/logout', {}, { Cookie: cookie })).status, 403);
    const rotated = await f.post('/ui/login', { password }, { Cookie: cookie }); assert.equal(rotated.status, 200);
    assert.equal((await fetch(`${f.base}/v1/namespaces`, { headers })).status, 401);
    const rotatedHeaders = { Cookie: rotated.headers.getSetCookie()[0]!.split(';')[0]!, 'X-CSRF-Token': (await rotated.json() as { csrf: string }).csrf };
    assert.equal((await f.post('/ui/logout', {}, rotatedHeaders)).status, 204);
    assert.equal((await fetch(`${f.base}/v1/namespaces`, { headers: rotatedHeaders })).status, 401);
    assert.equal((await fetch(`${f.base}/v1/namespaces`, { headers: { Cookie: `${cookie}tampered` } })).status, 401);
    const page = await fetch(f.base); assert.equal(page.status, 200); assert.match(page.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
    const html = await page.text(); assert.match(html, /记忆管理台/); assert(!html.includes(password));
    const script = /src="(\/assets\/[^\"]+\.js)"/.exec(html)?.[1]; assert(script);
    assert.equal((await fetch(`${f.base}${script}`)).status, 200);
    assert.equal((await fetch(`${f.base}/assets/not-found.js`)).status, 404);
  } finally { await f.close(); }
});

test('未配置密码时关闭登录；HTTPS Cookie 固定 Secure；弱密码拒绝启动', async () => {
  assert.throws(() => config({ ADMIN_PASSWORD: 'short' }));
  const disabled = await fixture('');
  try {
    assert.deepEqual(await (await fetch(`${disabled.base}/ui/session`)).json(), { enabled: false, authenticated: false });
    assert.equal((await disabled.post('/ui/login', { password })).status, 503);
  } finally { await disabled.close(); }
  const secure = await fixture(password, true);
  try {
    const response = await secure.post('/ui/login', { password }); assert.equal(response.status, 200); assert.match(response.headers.getSetCookie()[0]!, /; Secure/);
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    assert.equal((await fetch(`${secure.base}/v1/namespaces`, { headers: { Cookie: cookie } })).status, 401);
    assert.equal((await fetch(`${secure.base}/v1/namespaces`, { headers: { Cookie: cookie, 'X-Forwarded-Proto': 'https' } })).status, 200);
    assert.equal((await secure.post('/ui/login', { password }, { 'X-Forwarded-Proto': 'http' })).status, 403);
    const root = await fetch(secure.base, { redirect: 'manual', headers: { 'X-Forwarded-Host': 'memory.example.test' } }); assert.equal(root.status, 302); assert.equal(root.headers.get('location'), 'https://memory.example.test');
    const secureResponse = await fetch(`${secure.base}/ui/session`, { headers: { 'X-Forwarded-Proto': 'https' } });
    assert.equal(secureResponse.headers.get('strict-transport-security'), 'max-age=31536000');
    assert.equal(root.headers.get('strict-transport-security'), null);
  }
  finally { await secure.close(); }
});

test('会话固定 12 小时过期，登录独立限流', async () => {
  const f = await fixture(); const realNow = Date.now;
  try {
    const response = await f.post('/ui/login', { password });
    const cookie = response.headers.getSetCookie()[0]!.split(';')[0]!;
    const now = Date.now(); Date.now = () => now + 12 * 60 * 60 * 1000 + 1;
    assert.equal((await fetch(`${f.base}/v1/namespaces`, { headers: { Cookie: cookie } })).status, 401);
    Date.now = realNow;
    for (let i = 0; i < 4; i++) assert.equal((await f.post('/ui/login', { password: 'wrong' })).status, 401);
    const limited = await f.post('/ui/login', { password }); assert.equal(limited.status, 429); assert(limited.headers.get('Retry-After'));
  } finally { Date.now = realNow; await f.close(); }
});
