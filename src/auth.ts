import { createHash } from 'node:crypto';
import type { AuthInfo } from '@modelcontextprotocol/server';
import type { Pool } from 'pg';
import type { RequestHandler } from 'express';
import type Provider from 'oidc-provider';
import { AppError } from './validation.js';

export interface Identity { clientId: string; scopes: string[]; tokenId?: string }
export class InsufficientScope extends AppError {
  constructor(public scope: string) { super(403, 'insufficient_scope'); }
}
export function hasScope(identity: Identity, scope: string) {
  return identity.scopes.includes(scope) || identity.scopes.includes('memory:admin');
}
export function requireScope(identity: Identity, scope: string) {
  if (!hasScope(identity, scope)) throw new InsufficientScope(scope);
}
export function bearerChallenge(metadataUrl?: string, error?: 'invalid_token' | 'insufficient_scope', scope?: string) {
  const parameters = [
    error && `error="${error}"`,
    scope && `scope="${scope}"`,
    metadataUrl && `resource_metadata="${metadataUrl}"`,
  ].filter(Boolean);
  return parameters.length ? `Bearer ${parameters.join(', ')}` : 'Bearer';
}
export function authentication(pool: Pool, resource: string, provider?: Provider, metadataUrl?: string): RequestHandler {
  return async (req, res, next) => {
    try {
      const authorization = req.headers.authorization;
      if (!authorization) throw new AppError(401, 'authentication_required');
      const token = /^Bearer +([A-Za-z0-9._~+/-]+=*)$/i.exec(authorization)?.[1];
      if (!token || token.length > 4096) throw new AppError(401, 'invalid_token');
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
      const auth: AuthInfo = { token, clientId: identity.clientId, scopes: identity.scopes, resourceMetadataUrl: metadataUrl };
      Object.assign(req, { auth });
      next();
    } catch (error) {
      if (error instanceof AppError && error.status === 401) {
        res.setHeader('WWW-Authenticate', bearerChallenge(metadataUrl, error.code === 'invalid_token' ? 'invalid_token' : undefined));
      }
      next(error);
    }
  };
}
