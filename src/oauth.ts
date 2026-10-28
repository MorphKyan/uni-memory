import { readFile } from 'node:fs/promises';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import Provider, { errors } from 'oidc-provider';
import type { Pool } from 'pg';
import express, { type Express } from 'express';
import { z } from 'zod';
import type { Config } from './config.js';
import { passwordMatches } from './auth.js';
import { AppError } from './validation.js';

function oauthAdapter(pool: Pool) {
  return class Adapter {
    constructor(private model: string) {}
    async upsert(id: string, payload: Record<string, unknown>, expiresIn: number) {
      await pool.query(`INSERT INTO oauth_state(model,id,payload,expires_at,grant_id,uid,user_code)
        VALUES($1,$2,$3,CASE WHEN $4::integer IS NULL THEN NULL ELSE now()+$4*interval '1 second' END,$5,$6,$7)
        ON CONFLICT(model,id) DO UPDATE SET payload=EXCLUDED.payload,expires_at=EXCLUDED.expires_at,
        grant_id=EXCLUDED.grant_id,uid=EXCLUDED.uid,user_code=EXCLUDED.user_code`,
      [this.model, id, payload, expiresIn || null, payload.grantId, payload.uid, payload.userCode]);
    }
    async find(id: string) { return this.lookup('id', id); }
    async findByUid(uid: string) { return this.lookup('uid', uid); }
    async findByUserCode(code: string) { return this.lookup('user_code', code); }
    private async lookup(column: string, value: string) {
      return (await pool.query(`SELECT payload FROM oauth_state WHERE model=$1 AND ${column}=$2 AND (expires_at IS NULL OR expires_at>now())`, [this.model, value])).rows[0]?.payload;
    }
    async destroy(id: string) { await pool.query('DELETE FROM oauth_state WHERE model=$1 AND id=$2', [this.model, id]); }
    async consume(id: string) {
      const result = await pool.query(`UPDATE oauth_state SET payload=jsonb_set(payload,'{consumed}',to_jsonb(extract(epoch FROM now())::bigint))
        WHERE model=$1 AND id=$2 AND NOT payload ? 'consumed'`, [this.model, id]);
      if (result.rowCount !== 1) throw new Error('OAuth token already consumed');
    }
    async revokeByGrantId(id: string) { await pool.query('DELETE FROM oauth_state WHERE grant_id=$1', [id]); }
  };
}
export async function createOAuth(pool: Pool, cfg: Config) {
  if (!cfg.ownerHash || !cfg.cookieKey || cfg.cookieKey.length < 32) throw new Error('OAuth 缺少 owner hash 或 cookie key');
  const clients = z.array(z.object({
    client_id: z.string().min(1), client_secret: z.string().min(32).optional(),
    redirect_uris: z.array(z.url()).min(1),
    token_endpoint_auth_method: z.enum(['none', 'client_secret_post', 'client_secret_basic']).default('none'),
  }).strict()).parse(JSON.parse(cfg.oauthClients));
  for (const client of clients) {
    if (client.token_endpoint_auth_method !== 'none' && !client.client_secret) throw new Error('OAuth confidential client 缺少 secret');
    for (const redirect of client.redirect_uris) {
      const url = new URL(redirect);
      if (url.hash || url.username || url.password || (url.protocol !== 'https:'
        && (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) {
        throw new Error('OAuth 回调地址必须使用 HTTPS 或本机 HTTP');
      }
    }
  }
  const provider = new Provider(`${cfg.publicUrl}/oauth`, {
    adapter: oauthAdapter(pool),
    jwks: JSON.parse(await readFile(cfg.jwksPath, 'utf8')),
    cookies: { keys: [cfg.cookieKey], long: { sameSite: 'lax' }, short: { sameSite: 'lax' } },
    clients: clients.map(client => ({ ...client, grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] })),
    scopes: ['openid', 'offline_access', 'memory:read', 'memory:write'],
    claims: { openid: ['sub'] },
    clientBasedCORS: (_ctx, origin) => cfg.allowedOrigins.includes(origin),
    renderError: async (ctx) => { ctx.type = 'text/html'; ctx.body = '<!doctype html><meta charset="utf-8"><title>授权失败</title><p>授权请求无效，请检查客户端、回调、权限及 PKCE 配置。</p>'; },
    pkce: { required: () => true },
    features: {
      devInteractions: { enabled: false },
      revocation: { enabled: true },
      resourceIndicators: {
        enabled: true,
        defaultResource: () => cfg.resource,
        useGrantedResource: () => true,
        getResourceServerInfo: (_ctx, resource) => {
          if (resource !== cfg.resource) throw new errors.InvalidTarget();
          return { scope: 'memory:read memory:write', audience: cfg.resource, accessTokenTTL: 3600, accessTokenFormat: 'opaque' };
        },
      },
    },
    interactions: { url: (_ctx, interaction) => `/interaction/${interaction.uid}` },
    ttl: { AccessToken: 3600, IdToken: 3600, AuthorizationCode: 120, RefreshToken: 14 * 86400, Session: 86400, Interaction: 600, Grant: 14 * 86400 },
    rotateRefreshToken: true,
    findAccount: async (_ctx, id) => id === 'owner' ? { accountId: 'owner', claims: async () => ({ sub: 'owner' }) } : undefined,
  });
  provider.proxy = cfg.trustProxy.length > 0;
  return provider;
}
const escapeHtml = (input: unknown) => String(input).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
export function mountOAuth(app: Express, provider: Provider, cfg: Config) {
  app.get('/interaction/:uid', async (req, res) => {
    const details = await provider.interactionDetails(req, res);
    const csrf = randomBytes(32).toString('hex');
    res.cookie('um_csrf', csrf, { httpOnly: true, secure: cfg.publicUrl.startsWith('https:'), sameSite: 'strict', path: `/interaction/${details.uid}`, maxAge: 600000 });
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
    res.send(`<!doctype html><html lang="zh"><meta charset="utf-8"><title>uni-memory 授权</title><h1>uni-memory</h1>
      <p>客户端：${escapeHtml(details.params.client_id)}</p><p>权限：${escapeHtml(details.params.scope)}</p>
      <form method="post" action="/interaction/${escapeHtml(details.uid)}"><input type="hidden" name="csrf" value="${csrf}">
      ${details.prompt.name === 'login' ? '<label>个人口令 <input type="password" name="password" maxlength="1024" required autocomplete="current-password"></label>' : '<p>允许此客户端访问以上记忆权限？</p>'}
      <button type="submit">${details.prompt.name === 'login' ? '登录' : '允许'}</button></form></html>`);
  });
  app.post('/interaction/:uid', express.urlencoded({ extended: false, limit: '4kb' }), async (req, res) => {
    if (req.headers.origin !== cfg.publicUrl) throw new AppError(403, 'invalid_origin');
    const cookie = /(?:^|;\s*)um_csrf=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie ?? '')?.[1];
    const submitted = typeof req.body.csrf === 'string' && /^[a-f0-9]{64}$/.test(req.body.csrf) ? req.body.csrf : '';
    if (!cookie || !submitted || !timingSafeEqual(Buffer.from(cookie), Buffer.from(submitted))) throw new AppError(403, 'invalid_csrf');
    const details = await provider.interactionDetails(req, res);
    if (details.prompt.name === 'login') {
      if (typeof req.body.password !== 'string' || !passwordMatches(req.body.password, cfg.ownerHash!)) throw new AppError(401, 'invalid_login');
      await provider.interactionFinished(req, res, { login: { accountId: 'owner' } }, { mergeWithLastSubmission: false });
    } else if (details.prompt.name === 'consent' && details.session?.accountId === 'owner') {
      const grant = details.grantId ? await provider.Grant.find(details.grantId) : new provider.Grant({ accountId: 'owner', clientId: String(details.params.client_id) });
      if (!grant) throw new AppError(400, 'invalid_grant');
      const info = details.prompt.details;
      if (info.missingOIDCScope) grant.addOIDCScope((info.missingOIDCScope as string[]).join(' '));
      if (info.missingOIDCClaims) grant.addOIDCClaims(info.missingOIDCClaims as string[]);
      if (info.missingResourceScopes) {
        for (const [resource, scopes] of Object.entries(info.missingResourceScopes as Record<string, string[]>)) {
          if (resource !== cfg.resource) throw new AppError(400, 'invalid_resource');
          grant.addResourceScope(resource, scopes.join(' '));
        }
      }
      await provider.interactionFinished(req, res, { consent: { grantId: await grant.save() } }, { mergeWithLastSubmission: true });
    } else throw new AppError(400, 'unsupported_interaction');
  });
  app.use('/oauth', provider.callback());
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.redirect(302, '/oauth/.well-known/oauth-authorization-server'));
}
