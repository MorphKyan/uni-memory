import { createHash, randomBytes, scrypt, scryptSync, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import type Provider from 'oidc-provider';
import { AppError } from './validation.js';

export interface Identity { clientId: string; scopes: string[]; tokenId?: string }
const passwordSalt = () => randomBytes(16).toString('hex');
export function passwordHash(password: string) {
  if (password.length < 16 || password.length > 1024) throw new Error('口令须为 16–1024 字符');
  const salt = passwordSalt();
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
const scryptAsync = promisify(scrypt);
let passwordChecks = 0;
export async function derivePassword(password: string, salt: string) {
  // 不排队堆积匿名登录请求，给数据库等工作留出线程池容量。
  if (passwordChecks >= 2) throw new AppError(503, 'password_check_busy');
  passwordChecks++;
  try { return await scryptAsync(password, salt, 64) as Buffer; }
  finally { passwordChecks--; }
}
export async function newPasswordHash(password: string) {
  const salt = passwordSalt();
  return `${salt}:${(await derivePassword(password, salt)).toString('hex')}`;
}
export async function passwordMatches(password: string, encoded: string) {
  if (password.length > 1024) return false;
  const [salt, hex] = encoded.split(':');
  if (!salt || !hex || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(hex)) return false;
  return timingSafeEqual(await derivePassword(password, salt), Buffer.from(hex, 'hex'));
}
export function requireScope(identity: Identity, scope: string) {
  if (!identity.scopes.includes(scope) && !identity.scopes.includes('memory:admin')) throw new AppError(403, 'insufficient_scope');
}
export function authentication(pool: Pool, resource: string, provider?: Provider): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new AppError(401, 'authentication_required');
      const row = (await pool.query('SELECT id,client_id,scopes,revoked_at IS NULL AND expires_at>now() AS active FROM client_tokens WHERE token_hash=$1', [createHash('sha256').update(token).digest('hex')])).rows[0];
      if (row) res.locals.auditToken = { clientId: row.client_id, tokenId: row.id };
      let identity: Identity | undefined = row?.active ? { clientId: row.client_id, scopes: row.scopes, tokenId: row.id } : undefined;
      if (!identity && provider) {
        const access = await provider.AccessToken.find(token);
        if (access && !access.isExpired && access.accountId === 'owner' && access.aud === resource && access.clientId) {
          const grant = access.grantId && await provider.Grant.find(access.grantId);
          if (grant) identity = { clientId: `oauth:${access.clientId}`, scopes: access.scope?.split(' ') ?? [] };
        }
      }
      if (!identity) throw new AppError(401, 'invalid_token');
      res.locals.identity = identity;
      next();
    } catch (error) {
      if (error instanceof AppError && error.status === 401) {
        res.setHeader('WWW-Authenticate', `Bearer resource_metadata="${new URL('/.well-known/oauth-protected-resource', resource)}"`);
      }
      next(error);
    }
  };
}
