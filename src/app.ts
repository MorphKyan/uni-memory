import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type Provider from 'oidc-provider';
import type { Config } from './config.js';
import { authentication, requireScope, type Identity } from './auth.js';
import { mountOAuth } from './oauth.js';
import { createMcpServer } from './mcp.js';
import { AppError } from './validation.js';
import type { Store } from './store.js';
import type { Search } from './search.js';
import type { Qdrant } from './qdrant.js';
import type { Embedder } from './embedding.js';
import { MemoryStatus } from './status.js';
import { mountAdmin } from './admin.js';
import { auditRequests, summarizeMemoryResult, type MemoryAudit, type ToolAudit } from './audit.js';

interface Services { store: Store; search: Search; qdrant: Qdrant; cfg: Config; provider?: Provider; embedder?: Embedder }
export function rateLimit(limit: number, windowMs = 60000): RequestHandler {
  const clients = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let record = clients.get(key);
    if (!record || record.until <= now) {
      if (clients.size >= 10000) for (const [id, item] of clients) if (item.until <= now) clients.delete(id);
      if (clients.size >= 10000) { res.locals.auditError = 'rate_limited'; res.status(429).json({ error: 'rate_limited' }); return; }
      record = { count: 0, until: now + windowMs }; clients.set(key, record);
    }
    if (++record.count > limit) {
      res.locals.auditError = 'rate_limited';
      res.setHeader('Retry-After', Math.ceil((record.until - now) / 1000));
      res.status(429).json({ error: 'rate_limited' }); return;
    }
    next();
  };
}
export function createApp(services: Services) {
  const app = express();
  const { cfg, store, search, qdrant, provider } = services;
  const status = new MemoryStatus(store, qdrant, services.embedder);
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  if (cfg.trustProxy.length) app.set('trust proxy', cfg.trustProxy);
  app.use(auditRequests(store.pool));
  app.use(hostHeaderValidation(cfg.allowedHosts));
  app.use((req, res, next) => {
    // 本服务不使用转发 Host；Koa OAuth 也只能看到 Express 已核实来源的协议。
    const protocol = req.protocol;
    delete req.headers['x-forwarded-host'];
    req.headers['x-forwarded-proto'] = protocol;
    if (cfg.publicUrl.startsWith('https:') && req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin && !cfg.allowedOrigins.includes(req.headers.origin)) throw new AppError(403, 'invalid_origin');
    next();
  });
  app.use(rateLimit(120));
  app.post('/interaction/:uid', rateLimit(10));
  app.use(['/oauth/auth', '/oauth/token'], rateLimit(30));
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  app.get('/readyz', async (_req, res) => {
    let database = false; let vectors = false;
    try { await store.pool.query('SELECT 1'); database = true; } catch { /* 不暴露连接信息 */ }
    try { await qdrant.request('/collections'); vectors = true; } catch { /* 启动或故障中 */ }
    res.status(database && vectors ? 200 : 503).json({ database, qdrant: vectors, embedding_configured: !!cfg.model });
  });
  app.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
    res.json({ resource: cfg.resource, authorization_servers: provider ? [`${cfg.publicUrl}/oauth`] : [], scopes_supported: ['memory:read', 'memory:write'], bearer_methods_supported: ['header'] });
  });
  if (provider) mountOAuth(app, provider, cfg);
  app.use('/v1', mountAdmin(app, cfg, store.pool, rateLimit(5)));
  const auth = authentication(store.pool, cfg.resource, provider);
  app.use(['/v1', '/mcp'], (req, res, next) => res.locals.identity ? next() : auth(req, res, next), express.json({ limit: '32kb', strict: true }));
  function scope(name: string): RequestHandler {
    return (_req, res, next) => { requireScope(res.locals.identity as Identity, name); next(); };
  }
  function queryScope(req: express.Request) {
    const input = { ...req.query };
    if (typeof input.namespaces === 'string') input.namespaces = [input.namespaces];
    if (typeof input.tags === 'string') input.tags = [input.tags];
    if (typeof input.device_tags === 'string') input.device_tags = [input.device_tags];
    // GET 参数仅接受明确的 true/false，不将字符串 "false" 转成 true。
    return { ...input, ...(input.include_descendants === 'true' ? { include_descendants: true }
      : input.include_descendants === 'false' ? { include_descendants: false } : {}) };
  }
  function memoryRead(operation: string, run: (req: express.Request, audit: MemoryAudit) => Promise<unknown>): RequestHandler {
    return async (req, res) => {
      const audit: MemoryAudit = {};
      res.locals.auditMemory = audit;
      const result = await run(req, audit);
      Object.assign(audit, summarizeMemoryResult(operation, result));
      res.json(result);
    };
  }
  app.get('/v1/memories/core', scope('memory:read'), memoryRead('memory_context', req => store.core(queryScope(req))));
  app.get('/v1/status', scope('memory:read'), async (req, res) => { res.json(await status.get(queryScope(req))); });
  app.post('/v1/memories/search', scope('memory:read'), memoryRead('memory_search', (req, audit) => {
    audit.search_timings_ms = {};
    return search.search(req.body, audit.search_timings_ms);
  }));
  app.get('/v1/namespaces', scope('memory:read'), memoryRead('memory_namespaces', req => store.namespaces(req.query)));
  app.post('/v1/memories/list', scope('memory:read'), memoryRead('memory_list', req => store.list(req.body)));
  app.get('/v1/memories', scope('memory:read'), memoryRead('memory_get', req => store.get(req.query)));
  app.get('/v1/memories/history', scope('memory:read'), memoryRead('memory_history', req => store.history(req.query)));
  function memoryMutation(operation: 'write' | 'delete'): RequestHandler {
    return async (req, res) => {
      const audit: MemoryAudit = {};
      const work = store[operation]((res.locals.identity as Identity).clientId, req.body, () => { audit.idempotent_replay = true; })
        .then(result => {
          res.locals.auditMemory = Object.assign(audit, summarizeMemoryResult(`memory_${operation}`, result));
          return result;
        });
      res.locals.auditWork = work;
      const result = await work;
      res.status(result.status === 'conflict' ? 409 : result.status === 'created' ? 201 : 200).json(result);
    };
  }
  app.post('/v1/memories', scope('memory:write'), memoryMutation('write'));
  app.post('/v1/memories/delete', scope('memory:write'), memoryMutation('delete'));
  app.get('/v1/tasks', scope('memory:admin'), async (_req, res) => {
    res.json((await store.pool.query('SELECT memory_id,attempts,failed,available_at,error_code FROM index_jobs ORDER BY available_at LIMIT 100')).rows);
  });
  app.post('/mcp', async (req, res) => {
    const results = new Map<string | number, ToolAudit>();
    res.locals.auditToolResults = results;
    const handler = createMcpHandler(() => createMcpServer(store, search, status, res.locals.identity, (id, result) => results.set(id, result)));
    try {
      const work = toNodeHandler(handler)(req, res, req.body);
      res.locals.auditWork = work;
      await work;
    }
    finally { await handler.close(); }
  });
  app.all('/mcp', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).end(); });
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    const { status, code } = error instanceof AppError ? error
      : error instanceof z.ZodError || error instanceof SyntaxError ? { status: 400, code: 'invalid_input' }
        : (error as { type?: string }).type === 'entity.too.large' ? { status: 413, code: 'request_too_large' }
          : { status: 500, code: 'internal_error' };
    res.locals.auditError = code;
    res.status(status).json({ error: code });
  };
  app.use(errors);
  return app;
}
