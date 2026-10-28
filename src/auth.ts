import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import type Provider from 'oidc-provider';
import { AppError } from './validation.js';

export interface Identity { clientId: string; scopes: string[] }
export function hashToken(token: string) { return createHash('sha256').update(token).digest('hex'); }
export function passwordHash(password: string) {
  if (password.length < 16 || password.length > 1024) throw new Error('口令须为 16–1024 字符');
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function passwordMatches(password: string, encoded: string) {
  if (password.length > 1024) return false;
  const [salt, hex] = encoded.split(':');
  if (!salt || !hex || !/^[0-9a-f]{32}$/.test(salt) || !/^[0-9a-f]{128}$/.test(hex)) return false;
  return timingSafeEqual(scryptSync(password, salt, 64), Buffer.from(hex, 'hex'));
}
export function requireScope(identity: Identity, scope: string) {
  if (!identity.scopes.includes(scope) && !identity.scopes.includes('memory:admin')) throw new AppError(403, 'insufficient_scope');
}
export async function issueToken(pool: Pool, clientId: string, scopes: string[], days = 90) {
  if (!/^[a-zA-Z0-9_.-]{1,80}$/.test(clientId) || !scopes.length
    || scopes.some(scope => !['memory:read', 'memory:write', 'memory:admin'].includes(scope))
    || !Number.isInteger(days) || days < 1 || days > 365) throw new Error('客户端、权限或有效期无效');
  const token = randomBytes(32).toString('base64url');
  const id = randomUUID();
  await pool.query('INSERT INTO client_tokens(id,client_id,token_hash,scopes,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval \'1 day\')',
    [id, clientId, hashToken(token), scopes, days]);
  return { id, token };
}
export function authentication(pool: Pool, resource: string, provider?: Provider): RequestHandler {
  return async (req, res, next) => {
    try {
      const token = /^Bearer ([A-Za-z0-9._~-]{20,4096})$/.exec(req.headers.authorization ?? '')?.[1];
      if (!token) throw new AppError(401, 'authentication_required');
      const row = (await pool.query('SELECT client_id,scopes FROM client_tokens WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [hashToken(token)])).rows[0];
      let identity: Identity | undefined = row && { clientId: row.client_id, scopes: row.scopes };
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
