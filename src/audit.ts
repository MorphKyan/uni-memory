import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { RequestHandler } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Identity } from './auth.js';
import { memoryType } from './scope.js';
import type { BearerRecord } from './tokens.js';

const routes = new Set([
  '/', '/healthz', '/readyz', '/mcp',
  '/v1/memories', '/v1/memories/core', '/v1/memories/search', '/v1/memories/history',
  '/v1/memories/list', '/v1/memories/delete', '/v1/status', '/v1/namespaces', '/v1/tasks',
  '/ui/session', '/ui/login', '/ui/logout', '/ui/password', '/ui/bearers',
  '/oauth/auth', '/oauth/token', '/oauth/token/revocation', '/oauth/jwks', '/oauth/.well-known/oauth-authorization-server',
  '/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp',
  '/.well-known/oauth-authorization-server', '/.well-known/oauth-authorization-server/oauth',
]);
const methods = new Set(['server/discover', 'initialize', 'notifications/initialized', 'notifications/cancelled',
  'ping', 'tools/list', 'tools/call', 'resources/list', 'resources/read', 'prompts/list', 'prompts/get']);
const tools = new Set(['memory_search', 'memory_get', 'memory_write', 'memory_history', 'memory_delete',
  'memory_context', 'memory_namespaces', 'memory_list', 'memory_status']);
const channels = ['rest', 'mcp', 'oauth', 'admin', 'other'] as const;
const outcomes = ['success', 'error', 'disconnected'] as const;

export type SearchTimings = Partial<Record<'postgresql' | 'embedding' | 'qdrant', number>>;

export interface MemoryAudit {
  memory_id?: string;
  mutation_result?: 'created' | 'updated' | 'merged' | 'deleted' | 'conflict';
  memory_version?: number;
  idempotent_replay?: boolean;
  returned_count?: number;
  source_count?: number;
  has_more?: boolean;
  search_degraded?: boolean;
  search_timings_ms?: SearchTimings;
}

export interface ToolAudit extends MemoryAudit {
  error?: string;
  tool_duration_ms?: number;
}

function roundSearchTimings(audit?: MemoryAudit) {
  if (!audit?.search_timings_ms) return audit;
  const timings = Object.entries(audit.search_timings_ms).map(([stage, ms]) => [stage, Math.round(ms)]);
  return { ...audit, search_timings_ms: Object.fromEntries(timings) };
}

export function summarizeMemoryResult(operation: string, value: unknown): MemoryAudit | undefined {
  const result = value as {
    status?: MemoryAudit['mutation_result'];
    memory?: { id: string; version: number };
    id?: string;
    memories?: unknown[];
    namespaces?: unknown[];
    sources?: unknown[];
    next_cursor?: string | null;
    degraded?: boolean;
  } | null | undefined;
  if (!result) return;
  switch (operation) {
    case 'memory_write':
    case 'memory_delete':
      return {
        memory_id: result.memory?.id ?? result.id,
        mutation_result: result.status,
        memory_version: result.memory?.version,
      };
    case 'memory_get':
      return { returned_count: 1, source_count: result.sources?.length };
    case 'memory_history':
    case 'memory_context':
      return Array.isArray(result) ? { returned_count: result.length } : undefined;
    case 'memory_search':
      return { returned_count: result.memories?.length, search_degraded: result.degraded };
    case 'memory_list':
      return { returned_count: result.memories?.length, has_more: result.next_cursor != null };
    case 'memory_namespaces':
      return { returned_count: result.namespaces?.length };
  }
}

function describeInput(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const input = value as Record<string, unknown>;
  const type = memoryType.safeParse(input.type);
  return {
    namespace_count: Array.isArray(input.namespaces) ? input.namespaces.length : typeof input.namespaces === 'string' ? 1 : undefined,
    tag_count: Array.isArray(input.tags) ? input.tags.length : typeof input.tags === 'string' ? 1 : undefined,
    include_descendants: [true, false, 'true', 'false'].includes(input.include_descendants as boolean | string)
      ? String(input.include_descendants) === 'true' : undefined,
    memory_type: type.success ? type.data : undefined,
    query_length: typeof input.query === 'string' ? input.query.length : undefined,
    limit: typeof input.limit === 'number' && Number.isSafeInteger(input.limit) ? input.limit : undefined,
    has_cursor: typeof input.cursor === 'string' ? true : undefined,
    selector: typeof input.id === 'string' ? 'id' : typeof input.key === 'string' ? 'key' : undefined,
    has_parent: typeof input.parent === 'string' ? true : undefined,
    expected_version: typeof input.expected_version === 'number' && Number.isSafeInteger(input.expected_version) ? input.expected_version : undefined,
  };
}
function byteLength(value: unknown) {
  return typeof value === 'string' && /^\d{1,15}$/.test(value) ? Number(value)
    : typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

interface RpcInput {
  id?: string | number;
  method?: unknown;
  params?: { name?: unknown; arguments?: unknown; protocolVersion?: unknown };
}
function describeRpc(input: RpcInput | null | undefined, status: number | null, results?: Map<string | number, ToolAudit>) {
  const method = typeof input?.method === 'string' ? methods.has(input.method) ? input.method : '(other)' : undefined;
  const name = input?.params?.name;
  const tool = method === 'tools/call' && typeof name === 'string' ? tools.has(name) ? name : '(other)' : undefined;
  const id = input?.id;
  const result = method === 'tools/call' && id !== undefined
    ? results?.get(id) ?? (status === 200 ? { error: 'tool_rejected' } : undefined) : undefined;
  const { error, ...metrics } = result ?? {};
  return { method, tool, error, metrics: roundSearchTimings(metrics), input: tool ? describeInput(input?.params?.arguments) : undefined };
}

export function auditRequests(pool: Pool): RequestHandler {
  let pending = 0;
  let lastWarning = 0;
  function warn() {
    if (Date.now() - lastWarning < 60_000) return;
    lastWarning = Date.now();
    console.error(JSON.stringify({ event: 'request_audit_unavailable' }));
  }
  return (req, res, next) => {
    const path = req.path.replace(/\/$/, '').toLowerCase() || '/';
    // 轮询和读取审计本身不会制造新日志。探针仍会留下独立记录。
    if (path.startsWith('/assets/') || ((path === '/ui/audit' || path === '/ui/session') && req.method === 'GET')) return next();
    const channel = /^\/v1(?:\/|$)/.test(path) ? 'rest' : /^\/mcp(?:\/|$)/.test(path) ? 'mcp'
      : /^\/(?:oauth|interaction|\.well-known)(?:\/|$)/.test(path) ? 'oauth' : /^\/ui(?:\/|$)/.test(path) ? 'admin' : 'other';
    const route = routes.has(path) ? path
      : /^\/ui\/bearers\/[^/]+\/(edit|rotate|revoke)$/.test(path) ? `/ui/bearers/:id/${path.split('/').at(-1)}`
        : /^\/interaction\/[^/]+$/.test(path) ? '/interaction/:uid' : '(unmatched)';
    const requestId = randomUUID();
    const started = new Date();
    const time = performance.now();
    const forwardedIp = req.ip;
    const sourceIp = forwardedIp && isIP(forwardedIp) ? forwardedIp : req.socket.remoteAddress;
    res.setHeader('X-Request-ID', requestId);

    async function record(finished: boolean) {
      const duration = Math.round(performance.now() - time);
      const status = finished || res.headersSent ? res.statusCode : null;
      // 连接断开时，已开始的变更仍可能提交。
      const work = res.locals.auditWork as Promise<unknown> | undefined;
      if (!finished && work) await work.catch(() => undefined);
      if (pending >= 128) { warn(); return; }
      pending++;
      try {
        const identity = (res.locals.identity ?? res.locals.auditToken) as Identity | undefined;
        const body = (route === '/mcp' ? req.body : undefined) as RpcInput | RpcInput[] | undefined;
        const results = res.locals.auditToolResults as Map<string | number, ToolAudit> | undefined;
        const batch = Array.isArray(body) ? body.slice(0, 100).map(item => describeRpc(item, status, results)) : undefined;
        const rpc = !Array.isArray(body) ? describeRpc(body, status, results) : undefined;
        const error = res.locals.auditError ?? rpc?.error ?? (batch?.some(item => item.error) ? 'batch_tool_failed' : undefined);
        const mcpVersion = req.get('mcp-protocol-version') ?? (!Array.isArray(body) ? body?.params?.protocolVersion : undefined);
        const bearer = res.locals.auditBearer as BearerRecord | undefined;
        const details = {
          source_ip: sourceIp,
          ...rpc?.metrics,
          ...roundSearchTimings(res.locals.auditMemory as MemoryAudit | undefined),
          http_version: req.httpVersion,
          protocol: req.secure ? 'https' : req.protocol === 'http' ? 'http' : undefined,
          mcp_version: route === '/mcp' && typeof mcpVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(mcpVersion) ? mcpVersion : undefined,
          auth: identity?.tokenId ? 'bearer' : identity?.clientId.startsWith('oauth:') ? 'oauth'
            : identity ? 'session' : req.headers.authorization ? 'unverified' : undefined,
          request_bytes: byteLength(req.get('content-length')),
          response_bytes: byteLength(res.getHeader('content-length')),
          error,
          target_token_id: bearer?.id ?? res.locals.auditTargetTokenId,
          target_client_id: bearer?.client_id,
          target_scopes: bearer?.scopes,
          target_expires_at: bearer?.expires_at,
          target_version: bearer?.version,
          rpc_batch: batch?.map(({ metrics, ...call }) => ({ ...call, ...metrics })),
          rpc_batch_size: Array.isArray(body) ? body.length : undefined,
          input: channel === 'rest' && route !== '(unmatched)' ? describeInput(req.method === 'GET' || req.method === 'HEAD' ? req.query : req.body)
            : rpc?.input,
        };
        await pool.query(`INSERT INTO request_audit(request_id,started_at,channel,route,method,status,duration_ms,client_id,token_id,rpc_method,tool,outcome,details)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [requestId, started, channel, route, req.method, status, duration, identity?.clientId, identity?.tokenId,
          batch ? '(batch)' : rpc?.method, rpc?.tool, !finished ? 'disconnected' : (status ?? 0) >= 400 || error ? 'error' : 'success', details]);
      } catch { warn(); }
      finally { pending--; }
    }
    res.once('finish', () => { void record(true); });
    res.once('close', () => { if (!res.writableFinished) void record(false); });
    next();
  };
}

const filters = z.object({
  days: z.enum(['1', '7', '30', '90', '365']).default('1'),
  channel: z.enum(channels).optional(),
  outcome: z.enum(outcomes).optional(),
  client: z.string().trim().min(1).max(256).optional(),
  before: z.string().regex(/^[1-9]\d{0,18}$/).refine(value => BigInt(value) <= 9223372036854775807n).optional(),
  until: z.iso.datetime().optional(),
}).strict().refine(value => !!value.before === !!value.until);
export async function readAudit(pool: Pool, input: unknown) {
  const { days, channel, outcome, client, before, until } = filters.parse(input);
  const end = until ? new Date(until) : new Date();
  const since = new Date(end.getTime() - Number(days) * 86400_000);
  const where = `started_at >= $1 AND started_at <= $2 AND ($3::text IS NULL OR channel=$3)
    AND ($4::text IS NULL OR outcome=$4) AND ($5::text IS NULL OR client_id=$5)`;
  const values = [since, end, channel, outcome, client];
  const { rows } = await pool.query(`SELECT * FROM request_audit WHERE ${where}
    AND ($6::bigint IS NULL OR (started_at,id)<(SELECT started_at,id FROM request_audit WHERE id=$6))
    ORDER BY started_at DESC,id DESC LIMIT 51`, [...values, before]);
  const entries = rows.slice(0, 50);
  const next = rows.length > 50 ? entries.at(-1)!.id : null;
  if (before) return { entries, next };
  const unit = days === '1' ? 'hour' : 'day';
  const { rows: buckets } = await pool.query(`SELECT date_trunc($6,started_at,'UTC') AS time, outcome, count(*)::integer AS count
    FROM request_audit WHERE ${where} GROUP BY 1,2 ORDER BY 1,2`, [...values, unit]);
  return { entries, next, buckets, since, until: end, unit };
}
