import express, { type Express, type Request, type RequestHandler } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import type { Config } from './config.js';
import { AppError } from './validation.js';
import { derivePassword } from './auth.js';

const lifetime = 12 * 60 * 60 * 1000;
const cookieName = 'uni_memory_admin';
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export function mountAdmin(app: Express, cfg: Config, loginLimit: RequestHandler): RequestHandler {
  // 单容器会话仅保存在内存，重启或更换密码后必须重新登录。
  const sessions = new Map<string, { csrf: string; expires: number }>();
  const salt = randomBytes(16);
  const passwordKey = cfg.adminPassword ? derivePassword(cfg.adminPassword, salt) : undefined;
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
  app.get('/ui/session', (req, res) => {
    const session = current(req);
    res.json({ enabled: !!passwordKey, authenticated: !!session, csrf: session?.csrf });
  });
  app.post('/ui/login', loginLimit, browserRequest, express.json({ limit: '4kb' }), async (req, res) => {
    if (!passwordKey) throw new AppError(503, 'admin_disabled');
    const { password } = z.object({ password: z.string().min(1).max(1024) }).strict().parse(req.body);
    const candidate = await derivePassword(password, salt) as Buffer;
    if (!timingSafeEqual(candidate, await passwordKey as Buffer)) throw new AppError(401, 'invalid_password');
    for (const [key, session] of sessions) if (session.expires <= Date.now()) sessions.delete(key);
    const prior = current(req); if (prior) sessions.delete(prior.key);
    if (sessions.size >= 1000) throw new AppError(429, 'rate_limited');
    const token = randomBytes(32).toString('base64url');
    const csrf = randomBytes(32).toString('base64url');
    sessions.set(digest(token), { csrf, expires: Date.now() + lifetime });
    res.cookie(cookieName, token, { ...cookieOptions, maxAge: lifetime });
    res.json({ authenticated: true, csrf });
  });
  app.post('/ui/logout', browserRequest, (req, res) => {
    const session = current(req);
    if (!session) throw new AppError(401, 'authentication_required');
    if (req.headers['x-csrf-token'] !== session.csrf) throw new AppError(403, 'invalid_csrf');
    sessions.delete(session.key);
    res.clearCookie(cookieName, cookieOptions).status(204).end();
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
      if (!['GET', 'HEAD'].includes(req.method) && req.headers['x-csrf-token'] !== session.csrf) throw new AppError(403, 'invalid_csrf');
      res.locals.identity = { clientId: 'web-admin', scopes: ['memory:admin'] };
    }
    next();
  };
}
