import { z } from 'zod';

export function config(env: NodeJS.ProcessEnv = process.env) {
  const publicUrl = new URL(env.PUBLIC_URL ?? 'http://127.0.0.1:3000');
  const octets = publicUrl.hostname.split('.').map(Number);
  const privateIpv4 = octets.length === 4 && octets.every(n => Number.isInteger(n) && n >= 0 && n <= 255)
    && (octets[0] === 10 || (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) || (octets[0] === 192 && octets[1] === 168));
  const lanHttp = env.ALLOW_INSECURE_LAN_HTTP === 'true' && privateIpv4 && env.OAUTH_ENABLED !== 'true';
  if (publicUrl.pathname !== '/' || publicUrl.search || publicUrl.hash || publicUrl.username || publicUrl.password
    || !['http:', 'https:'].includes(publicUrl.protocol)
    || (publicUrl.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(publicUrl.hostname) && !lanHttp)) {
    throw new Error('PUBLIC_URL 必须是 HTTPS 根地址；仅本机或显式启用且关闭 OAuth 的私网 IPv4 可用 HTTP');
  }
  return {
    port: z.coerce.number().int().min(1).max(65535).parse(env.PORT ?? '3000'),
    host: env.HOST ?? '127.0.0.1',
    publicUrl: publicUrl.origin,
    resource: `${publicUrl.origin}/mcp`,
    allowedHosts: [publicUrl.hostname, 'localhost', '127.0.0.1', '[::1]'],
    allowedOrigins: [publicUrl.origin, ...(env.ALLOWED_ORIGINS?.split(',').filter(Boolean) ?? [])],
    trustProxy: env.TRUST_PROXY?.split(',').filter(Boolean) ?? [],
    qdrantUrl: env.QDRANT_URL ?? 'http://127.0.0.1:6333',
    qdrantKey: env.QDRANT_API_KEY,
    model: env.EMBEDDING_MODEL || undefined,
    modelCache: env.MODEL_CACHE ?? './.cache/models',
    oauthEnabled: env.OAUTH_ENABLED === 'true',
    ownerHash: env.OWNER_PASSWORD_HASH,
    jwksPath: env.OAUTH_JWKS_PATH ?? './.secrets/jwks.json',
    cookieKey: env.OAUTH_COOKIE_KEY,
    oauthClients: env.OAUTH_CLIENTS_JSON ?? '[]',
    organizeEnabled: env.EXTERNAL_ORGANIZE_ENABLED === 'true',
    llmBase: env.LLM_BASE_URL ?? 'https://token.sensenova.cn/v1',
    llmModel: env.LLM_MODEL,
    llmKey: env.LLM_API_KEY,
  };
}
export type Config = ReturnType<typeof config>;
