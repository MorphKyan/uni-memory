import express, { type Express, type Request, type RequestHandler } from 'express';
import { createHash, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError } from './validation.js';
import { newPasswordHash, passwordHash, passwordMatches } from './auth.js';
import { changeBearer, createBearer, listBearers } from './tokens.js';
import { readAudit } from './audit.js';

const lifetime = 12 * 60 * 60 * 1000;
const cookieName = 'uni_memory_admin';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function mountAdmin(app: Express, cfg: Config, pool: Pool, loginLimit: RequestHandler): RequestHandler {
  // 单容器会话仅保存在内存，重启或更换密码后必须重新登录。
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const bootstrapHash = cfg.adminPassword ? passwordHash(cfg.adminPassword) : undefined;
  const identity = { clientId: 'web-admin', scopes: ['memory:admin'] };
  let passwordGeneration = 0;
  async function savedHash() {
    return (await pool.query<{ password_hash: string }>('SELECT password_hash FROM admin_password WHERE singleton')).rows[0]?.password_hash;
  }
  const cookieOptions = { httpOnly: true, sameSite: 'strict' as const, secure: cfg.publicUrl.startsWith('https:'), path: '/' };
  function current(req: Request) {
    if (cookieOptions.secure && !req.secure) return undefined;
    const token = req.headers.cookie?.split(';').map(s => s.trim()).find(s => s.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    const key = token && /^[A-Za-z0-9_-]{43}$/.test(token) ? digest(token) : '';
    const session = sessions.get(key);
    if (session && session.expires <= Date.now()) { sessions.delete(key); return undefined; }
    return session && { key, ...session };
  }
  const browserRequest: RequestHandler = (req, _res, next) => {
    // 非简单请求头阻止跨站表单登录；全局 Origin 校验拒绝未授权来源。
    if (cookieOptions.secure && !req.secure) throw new AppError(403, 'https_required');
    if (req.headers['x-uni-memory-ui'] !== '1') throw new AppError(403, 'invalid_ui_request');
    next();
  };
  const sessionRequest: RequestHandler = (req, res, next) => {
    const session = !req.headers.authorization && current(req);
    if (!session) throw new AppError(401, 'authentication_required');
    res.locals.identity = identity;
    if (req.method !== 'GET' && req.method !== 'HEAD' && req.headers['x-csrf-token'] !== session.csrf) {
      throw new AppError(403, 'invalid_csrf');
    }
    res.locals.adminSession = session;
    next();
  };
  app.get('/ui/session', (req, res) => {
    const session = current(req);
    res.json({ enabled: !!bootstrapHash, authenticated: !!session, csrf: session?.csrf });
  });
  app.post('/ui/login', loginLimit, browserRequest, express.json({ limit: '8kb' }), async (req, res) => {
    if (!bootstrapHash) throw new AppError(503, 'admin_disabled');
    const { password } = z.object({ password: z.string().min(1).max(1024) }).strict().parse(req.body);
    const generation = passwordGeneration;
    if (!await passwordMatches(password, await savedHash() ?? bootstrapHash) || generation !== passwordGeneration) {
      throw new AppError(401, 'invalid_password');
    }
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    const prior = current(req); if (prior) sessions.delete(prior.key);
    if (sessions.size >= 1000) throw new AppError(429, 'rate_limited');
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    sessions.set(digest(token), { csrf, expires: Date.now() + lifetime });
    res.locals.identity = identity;
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: lifetime });
    res.json({ authenticated: true, csrf });
  });
  app.post('/ui/logout', browserRequest, sessionRequest, (_req, res) => {
    sessions.delete(res.locals.adminSession.key);
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  app.post('/ui/password', browserRequest, sessionRequest, loginLimit, express.json({ limit: '16kb' }), async (req, res) => {
    const { current_password, new_password } = z.object({
      current_password: z.string().min(1).max(1024),
      new_password: z.string().min(16).max(1024),
    }).strict().parse(req.body);
    const previous = await savedHash();
    if (!bootstrapHash || !await passwordMatches(current_password, previous ?? bootstrapHash)) throw new AppError(401, 'invalid_password');
    if (current_password === new_password) throw new AppError(400, 'password_unchanged');
    const hash = await newPasswordHash(new_password);
    const result = previous
      ? await pool.query('UPDATE admin_password SET password_hash=$1 WHERE singleton AND password_hash=$2', [hash, previous])
      : await pool.query('INSERT INTO admin_password(password_hash) VALUES($1) ON CONFLICT DO NOTHING', [hash]);
    if (result.rowCount !== 1) throw new AppError(409, 'password_changed');
    passwordGeneration++;
    sessions.clear();
    res.clearCookie(cookieName, cookieOptions).status(204).end();
  });
  app.get('/ui/bearers', browserRequest, sessionRequest, async (_req, res) => {
    res.json(await listBearers(pool));
  });
  app.post('/ui/bearers', browserRequest, sessionRequest, express.json({ limit: '4kb' }), async (req, res) => {
    const result = await createBearer(pool, req.body);
    res.locals.auditBearer = result.bearer;
    res.status(201).json(result);
  });
  app.post('/ui/bearers/:id/:action', browserRequest, sessionRequest, express.json({ limit: '4kb' }), async (req, res) => {
    const { id, action } = req.params;
    const target = z.uuid().safeParse(id);
    if (target.success) res.locals.auditTargetTokenId = target.data;
    const result = await changeBearer(pool, id, action, req.body);
    res.locals.auditBearer = result.bearer;
    res.json(result);
  });
  app.get('/ui/audit', browserRequest, sessionRequest, async (req, res) => {
    res.json(await readAudit(pool, req.query));
  });
  const directory = fileURLToPath(new URL('../web/', import.meta.url));
  const uiHeaders: RequestHandler = (_req, res, next) => {
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('X-Frame-Options', 'DENY'); next();
  };
  app.get('/', uiHeaders, (req, res) => {
    if (cookieOptions.secure && (!req.secure || req.get('host') !== new URL(cfg.publicUrl).host)) {
      res.redirect(302, cfg.publicUrl); return;
    }
    res.sendFile(`${directory}index.html`);
  });
  app.use('/assets', uiHeaders, express.static(`${directory}assets`, { index: false, redirect: false }));
  return (req, res, next) => {
    if (req.headers.authorization) { next(); return; }
    const session = current(req);
    if (session) {
      res.locals.identity = identity;
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) throw new AppError(403, 'invalid_csrf');
    }
    next();
  };
}
