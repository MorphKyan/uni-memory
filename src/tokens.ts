import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { z } from 'zod';
import { AppError } from './validation.js';

const settings = z.object({
  client_id: z.string().regex(/^[a-zA-Z0-9_.-]{1,80}$/),
  scopes: z.array(z.enum(['memory:read', 'memory:write', 'memory:admin'])).min(1),
}).strict();
const create = settings.extend({ days: z.number().int().min(1).max(365).default(90) });
const version = z.object({ expected_version: z.number().int().positive() }).strict();
const edit = settings.extend({
  ...version.shape,
  expires_at: z.iso.datetime({ offset: true }).refine(value => {
    const time = Date.parse(value);
    return time > 0 && time <= Date.now() + 365 * 86400_000;
  }),
});
const columns = 'id,client_id,scopes,expires_at,revoked_at,version';
const generate = () => randomBytes(32).toString('base64url');
const hash = (token: string) => createHash('sha256').update(token).digest('hex');
export interface BearerRecord {
  id: string;
  client_id: string;
  scopes: string[];
  expires_at: Date;
  revoked_at: Date | null;
  version: number;
}

export async function createBearer(pool: Pool, input: unknown) {
  const { client_id, scopes, days } = create.parse(input);
  const token = generate();
  const { rows } = await pool.query<BearerRecord>(`INSERT INTO client_tokens(id,client_id,token_hash,scopes,expires_at)
    VALUES($1,$2,$3,$4,now()+$5*interval '1 day') RETURNING ${columns}`,
  [randomUUID(), client_id, hash(token), [...new Set(scopes)], days]);
  return { bearer: rows[0]!, token };
}
export async function issueToken(pool: Pool, clientId: string, scopes: string[], days = 90) {
  const { bearer, token } = await createBearer(pool, { client_id: clientId, scopes, days });
  return { id: bearer.id, token };
}
export async function listBearers(pool: Pool) {
  return (await pool.query<BearerRecord>(`SELECT ${columns} FROM client_tokens ORDER BY expires_at DESC,id`)).rows;
}
export async function changeBearer(pool: Pool, id: unknown, action: unknown, input: unknown) {
  const tokenId = z.uuid().parse(id);
  const operation = z.enum(['edit', 'rotate', 'revoke']).parse(action);
  const token = operation === 'rotate' ? generate() : undefined;
  const values: unknown[] = [tokenId];
  let update: string;
  if (operation === 'edit') {
    const { expected_version, client_id, scopes, expires_at } = edit.parse(input);
    values.push(expected_version, client_id, [...new Set(scopes)], expires_at);
    update = 'client_id=$3,scopes=$4,expires_at=$5';
  } else {
    values.push(version.parse(input).expected_version);
    if (token) values.push(hash(token));
    update = token ? 'token_hash=$3' : 'revoked_at=now()';
  }
  const { rows } = await pool.query<BearerRecord>(`UPDATE client_tokens SET ${update},version=version+1
    WHERE id=$1 AND version=$2 AND revoked_at IS NULL RETURNING ${columns}`, values);
  const bearer = rows[0];
  if (!bearer) throw new AppError(409, 'bearer_changed');
  return { bearer, token };
}
