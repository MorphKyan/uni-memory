import express, { type ErrorRequestHandler, type RequestHandler } from 'express';
import { hostHeaderValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { z } from 'zod';
import type Provider from 'oidc-provider';
import { config, type Config } from './config.js';
import { authentication, requireScope, type Identity } from './auth.js';
import { mountOAuth } from './oauth.js';
import { createMcpServer } from './mcp.js';
import { AppError } from './validation.js';
import type { Store } from './store.js';
import type { Search } from './search.js';
import type { Qdrant } from './qdrant.js';

interface Services { store: Store; search: Search; qdrant: Qdrant; cfg: Config; provider?: Provider }
export function rateLimit(limit: number, windowMs = 60000): RequestHandler {
  const clients = new Map<string, { count: number; until: number }>();
  return (req, res, next) => {
    const now = Date.now();
    const key = req.ip ?? 'unknown';
    let record = clients.get(key);
    if (!record || record.until <= now) {
      if (clients.size >= 10000) for (const [id, item] of clients) if (item.until <= now) clients.delete(id);
      if (clients.size >= 10000) { res.status(429).json({ error: 'rate_limited' }); return; }
      record = { count: 0, until: now + windowMs }; clients.set(key, record);
    }
    if (++record.count > limit) { res.setHeader('Retry-After', Math.ceil((record.until - now) / 1000)); res.status(429).json({ error: 'rate_limited' }); return; }
    next();
  };
}
export function createApp(services?: Services) {
  const app = express();
  const cfg = services?.cfg ?? config();
  app.disable('x-powered-by');
  app.set('query parser', 'simple');
  if (cfg.trustProxy.length) app.set('trust proxy', cfg.trustProxy);
  app.use(hostHeaderValidation(cfg.allowedHosts));
  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    if (req.headers.origin && !cfg.allowedOrigins.includes(req.headers.origin)) { res.status(403).json({ error: 'invalid_origin' }); return; }
    next();
  });
  app.use(rateLimit(120));
  app.post('/interaction/:uid', rateLimit(10));
  app.use(['/oauth/auth', '/oauth/token'], rateLimit(30));
  app.get('/healthz', (_req, res) => { res.json({ status: 'ok' }); });
  if (services) {
    const { store, search, qdrant, provider } = services;
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
    const auth = authentication(store.pool, cfg.resource, provider);
    app.use(['/v1', '/mcp'], auth, express.json({ limit: '32kb', strict: true }));
    function scope(name: string): RequestHandler {
      return (_req, res, next) => { requireScope(res.locals.identity as Identity, name); next(); };
    }
    app.get('/v1/memories/core', scope('memory:read'), async (req, res) => {
      const input = { ...req.query };
      if (typeof input.namespaces === 'string') input.namespaces = [input.namespaces];
      if (typeof input.tags === 'string') input.tags = [input.tags];
      // GET 参数仅接受明确的 true/false，不将字符串 "false" 转成 true。
      res.json(await store.core({ ...input, ...(input.include_descendants === 'true' ? { include_descendants: true }
        : input.include_descendants === 'false' ? { include_descendants: false } : {}) }));
    });
    app.post('/v1/memories/search', scope('memory:read'), async (req, res) => { res.json(await search.search(req.body)); });
    app.get('/v1/memories', scope('memory:read'), async (req, res) => { res.json(await store.get(req.query)); });
    app.get('/v1/memories/history', scope('memory:read'), async (req, res) => { res.json(await store.history(req.query)); });
    app.post('/v1/memories', scope('memory:write'), async (req, res) => {
      const result = await store.write((res.locals.identity as Identity).clientId, req.body);
      res.status(result.status === 'conflict' ? 409 : result.status === 'created' ? 201 : 200).json(result);
    });
    app.post('/v1/memories/delete', scope('memory:write'), async (req, res) => {
      const result = await store.delete((res.locals.identity as Identity).clientId, req.body);
      res.status(result.status === 'conflict' ? 409 : 200).json(result);
    });
    app.get('/v1/tasks', scope('memory:admin'), async (_req, res) => {
      res.json((await store.pool.query('SELECT memory_id,attempts,failed,available_at,error_code FROM index_jobs ORDER BY available_at LIMIT 100')).rows);
    });
    app.post('/mcp', async (req, res) => {
      const server = createMcpServer(store, search, res.locals.identity);
      const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
      finally { await server.close(); }
    });
    app.all('/mcp', (_req, res) => { res.setHeader('Allow', 'POST'); res.status(405).end(); });
  }
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  const errors: ErrorRequestHandler = (error: unknown, _req, res, _next) => {
    if (res.headersSent) { res.end(); return; }
    if (error instanceof AppError) res.status(error.status).json({ error: error.code });
    else if (error instanceof z.ZodError || error instanceof SyntaxError) res.status(400).json({ error: 'invalid_input' });
    else if ((error as { type?: string }).type === 'entity.too.large') res.status(413).json({ error: 'request_too_large' });
    else res.status(500).json({ error: 'internal_error' });
  };
  app.use(errors);
  return app;
}
