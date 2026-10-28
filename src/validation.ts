import { z } from 'zod';
import { namespaceSchema, memoryType, verificationSchema, scopeShape } from './scope.js';

export class AppError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}
export const text = (max: number) => z.string().trim().min(1).max(max);
export const identifier = text(160);
export const memorySelector = z.object({ id: z.uuid().optional(), key: identifier.optional(), namespace: namespaceSchema.optional() })
  .strict().refine(value => value.id ? !value.key && !value.namespace : !!value.key && !!value.namespace,
    '提供 id，或 namespace 和 key');
export const writeSchema = z.object({
  namespace: namespaceSchema,
  type: memoryType,
  verification: verificationSchema,
  key: identifier,
  content: text(4000),
  tags: z.array(text(64)).max(20).default([]),
  pinned: z.boolean().default(false),
  expires_at: z.iso.datetime({ offset: true }).nullable().default(null),
  source: z.object({ reference: text(512), excerpt: z.string().trim().max(512).default('') }).strict(),
  expected_version: z.number().int().positive().optional(),
  idempotency_key: text(160),
}).strict();
export const deleteSchema = z.object({
  id: z.uuid(), expected_version: z.number().int().positive(), idempotency_key: text(160),
}).strict();
export const searchSchema = z.object({
  ...scopeShape,
  query: text(512), limit: z.number().int().min(1).max(50).default(10),
}).strict();
export function rejectSecrets(value: unknown) {
  const string = JSON.stringify(value);
  if (/(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-(?:proj-)?[a-zA-Z0-9_-]{16,}|\b(?:password|api[_-]?key|access[_-]?token|secret)\s*[:=]\s*["']?[^\s"',}]{8,}|https?:\/\/[^\s/:]+:[^\s/@]+@)/i.test(string)) {
    throw new AppError(422, 'possible_credentials');
  }
}
