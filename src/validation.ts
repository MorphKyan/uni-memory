import { z } from 'zod';
import { namespaceSchema, memoryType, verificationSchema, scopeShape } from './scope.js';

export class AppError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
const identifier = z.string().trim().min(1).max(160);
const memoryKey = z.string().normalize('NFKC').trim().min(1).max(160);
export const memorySelector = z.object({ id: z.uuid().optional(), key: memoryKey.optional(), namespace: namespaceSchema.optional() })
  .strict().refine(value => value.id ? !value.key && !value.namespace : !!value.key && !!value.namespace,
    '提供 id，或 namespace 和 key');
export const writeSchema = z.object({
  namespace: namespaceSchema,
  type: memoryType,
  verification: verificationSchema,
  key: memoryKey,
  content: z.string().trim().min(1).max(4000),
  tags: scopeShape.tags,
  pinned: z.boolean().default(false),
  expires_at: z.iso.datetime({ offset: true }).nullable().default(null),
  source: z.object({ reference: z.string().trim().min(1).max(512), excerpt: z.string().trim().max(512).default('') }).strict(),
  expected_version: z.number().int().positive().optional(),
  idempotency_key: identifier,
}).strict().refine(value => value.key !== 'overview' || value.expires_at === null,
  'overview 总览使用长期有效期 expires_at=null');
export const deleteSchema = z.object({
  id: z.uuid(), expected_version: z.number().int().positive(), idempotency_key: identifier,
}).strict();
export const searchSchema = z.object({
  ...scopeShape,
  query: z.string().trim().min(1).max(512), limit: z.number().int().min(1).max(50).default(10),
}).strict();
export const namespacesSchema = z.object({ parent: namespaceSchema.optional() }).strict();
export const listSchema = z.object({
  ...scopeShape,
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
const cursorSchema = z.object({ created_at: z.iso.datetime(), id: z.uuid() }).strict();
export function decodeListCursor(cursor: string) {
  try { return cursorSchema.parse(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))); }
  catch { throw new AppError(400, 'invalid_cursor'); }
}
export function rejectSecrets(value: unknown) {
  const string = JSON.stringify(value);
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[a-zA-Z0-9_-]{16,}|\b(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[^\s"',}]{8,}|https?:\/\/[^\s/:]+:[^\s/@]+@)/i.test(string)) {
    throw new AppError(422, 'possible_credentials');
  }
}
